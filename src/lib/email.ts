// Implements REQ-MAIL-001
// Implements REQ-MAIL-002 (transport-side: best-effort, never re-throws)
//
// Resend-backed transactional email for the global-feed pipeline.
//
// Render contract: `renderDigestReadyEmail` builds subject + text + html
// from a per-recipient input shape that includes the unread-headline
// list, the "since-midnight" tag tally, the local send-time line, and
// the recipient's app URL. The renderer is pure — no I/O, no clock —
// so it stays trivially testable. The dispatcher
// (src/lib/email-dispatch.ts) gathers all of those inputs before each
// per-user render call.
//
// Subject + preheader algorithm (REQ-MAIL-001 AC 3):
//   - 0 headlines  → static "Your news digest is ready" subject + empty
//                    preheader; body still ships tally + local-time +
//                    footer (AC 10).
//   - >0 headlines → "{N} new articles · {top 3 tag slugs}" subject;
//                    preheader is the comma-joined first-3 headline
//                    titles (Outlook/Gmail inbox-preview convention).
//
// HTML escaping: every user-derived string (article titles, source
// names, tag slugs, preheader) flows through `escapeHtml`. The only
// other interpolated value is `appUrl`, which is trusted env config
// but escaped anyway as defence-in-depth (a stray quote could break
// out of a href attribute).
//
// HTML constraints (Outlook/Gmail compatibility):
//   - Inline styles only — NO `<style>` blocks (regression-tested).
//   - Table-based layout, no flex/grid.
//   - Preheader hidden via `display:none;max-height:0;overflow:hidden;
//     mso-hide:all` so it appears in the inbox preview but not the
//     rendered body.
//
// Secrets hygiene (CON-SEC-001): `env.RESEND_API_KEY` is never logged,
// nor are full HTML/text bodies. `email.send.failed` logs carry only
// the recipient + HTTP status + Resend's short diagnostic — enough to
// triage, not enough to leak content.

import { log } from '~/lib/log';
import type { Headline, TagTally } from '~/lib/email-data';

/** External Gray Matter site that the email signature links to.
 *  Hardcoded — this is a brand link, not configurable per-deployment. */
const GRAY_MATTER_URL = 'https://graymatter.ch';

/** Resend REST endpoint — identical across environments. */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Per-call timeout. Longer than the median (~300ms) but short enough
 * that a stuck request never delays the cron's next branch. */
const RESEND_TIMEOUT_MS = 5000;

/** Escape a string for interpolation into HTML text or attribute
 * contexts. Minimal replacement set — covers the characters that can
 * break out of a text node or a double-quoted attribute value. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Zero-pad a 0-23 hour or 0-59 minute to two digits. */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Inputs required to render the rich digest-ready notification.
 *
 * `appUrl`            — site origin (e.g. https://news.graymatter.ch);
 *                        the renderer trims trailing slashes so links
 *                        never get a double slash.
 * `userDisplayName`    — currently unused by the template but reserved
 *                        for future personalisation; part of the public
 *                        shape so adding personalisation later is a
 *                        renderer change, not an interface change.
 * `headlines`          — top-N unread articles (typically 5); empty
 *                        triggers the static-subject fallback (AC 10).
 * `tagTally`           — per-tag counts, already sorted DESC by count;
 *                        empty omits the tally line entirely (AC 5).
 * `totalSinceMidnight` — total distinct articles in the tally window;
 *                        rendered as "Since midnight: N articles".
 * `sentLocal`          — recipient's tz + send hour/minute, used for
 *                        "Sent HH:MM Europe/Zurich" (AC 6).
 * `nextDigestLocal`    — tomorrow's send time hour/minute (same tz
 *                        as `sentLocal`), used for "next digest
 *                        tomorrow at HH:MM".
 */
export interface DigestReadyEmailParams {
  appUrl: string;
  userDisplayName: string;
  headlines: Headline[];
  tagTally: TagTally[];
  totalSinceMidnight: number;
  sentLocal: { hour: number; minute: number; tz: string };
  nextDigestLocal: { hour: number; minute: number };
}

/** Subject/body triple returned by {@link renderDigestReadyEmail}. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Render the rich daily digest email. Pure function — no I/O, no clock.
 * Subject reflects the unread-headline count + top tags; body lists the
 * headlines, the since-midnight tally, the local-time line, the
 * "Manage notifications" footer, and the clickable Gray Matter signature.
 */
export function renderDigestReadyEmail(params: DigestReadyEmailParams): RenderedEmail {
  const appUrl = params.appUrl.replace(/\/+$/, '');
  const safeAppUrlAttr = escapeHtml(appUrl);
  const settingsUrl = `${appUrl}/settings`;
  const safeSettingsUrlAttr = escapeHtml(settingsUrl);

  const { headlines, tagTally, totalSinceMidnight, sentLocal, nextDigestLocal } = params;

  // ---------- Subject ----------
  const topTagSlugs = tagTally.slice(0, 3).map((t) => t.tag);
  const articleNoun = headlines.length === 1 ? 'article' : 'articles';
  const subject =
    headlines.length === 0
      ? 'Your news digest is ready'
      : topTagSlugs.length > 0
        ? `${headlines.length} new ${articleNoun} · ${topTagSlugs.join(', ')}`
        : `${headlines.length} new ${articleNoun}`;

  // ---------- Preheader (hidden inbox-preview text) ----------
  const preheader = headlines.length === 0
    ? ''
    : headlines.slice(0, 3).map((h) => h.title).join(', ');

  // ---------- Local-time line ----------
  const sentLine =
    `Sent ${pad2(sentLocal.hour)}:${pad2(sentLocal.minute)} ${sentLocal.tz}` +
    ` · next digest tomorrow at ${pad2(nextDigestLocal.hour)}:${pad2(nextDigestLocal.minute)}`;

  // ---------- Tag tally line ----------
  // Omit when EITHER the per-tag breakdown is empty OR the total
  // count is zero — AC 5 says "the line is omitted entirely when no
  // articles have been ingested in that window". Gating on both
  // guards against the edge case where the two SQL queries that feed
  // them disagree (partial-result scenarios).
  const tallyLine = tagTally.length === 0 || totalSinceMidnight === 0
    ? null
    : `Since midnight: ${totalSinceMidnight} ${totalSinceMidnight === 1 ? 'article' : 'articles'}` +
      ` · ${tagTally.map((t) => `#${t.tag} (${t.count})`).join(' ')}`;

  // ---------- Plain-text body ----------
  const textLines: string[] = [];
  if (headlines.length === 0) {
    textLines.push('Your news digest is ready.');
  } else {
    textLines.push(`Your news digest is ready — ${headlines.length} new ${articleNoun} to read.`);
  }
  textLines.push('');
  if (headlines.length > 0) {
    for (const h of headlines) {
      const sourceSuffix = h.source_name !== null && h.source_name !== ''
        ? ` (${h.source_name})`
        : '';
      textLines.push(`- ${h.title}${sourceSuffix}`);
      textLines.push(`  ${appUrl}/digest/${h.id}/${h.slug}`);
    }
    textLines.push('');
  }
  if (tallyLine !== null) {
    textLines.push(tallyLine);
    textLines.push('');
  }
  textLines.push(sentLine);
  textLines.push('');
  textLines.push(`View your dashboard: ${appUrl}/digest`);
  textLines.push(`Manage notifications: ${settingsUrl}`);
  textLines.push('');
  textLines.push(`— Gray Matter (${GRAY_MATTER_URL})`);
  textLines.push('');
  const text = textLines.join('\n');

  // ---------- HTML body ----------
  const headlineRows = headlines.length === 0
    ? ''
    : `<tr><td style="padding-bottom:8px;">
        <table role="presentation" width="100%" style="border-collapse:collapse;">
          ${headlines.map((h) => {
            const safeTitle = escapeHtml(h.title);
            const safeSource = h.source_name !== null && h.source_name !== ''
              ? `<span style="color:#888; font-size:13px;"> · ${escapeHtml(h.source_name)}</span>`
              : '';
            const href = `${safeAppUrlAttr}/digest/${escapeHtml(h.id)}/${escapeHtml(h.slug)}`;
            return `<tr><td style="padding:6px 0; border-bottom:1px solid #eee;">
              <a href="${href}" style="color:#111; text-decoration:none; font-weight:600;">${safeTitle}</a>${safeSource}
            </td></tr>`;
          }).join('')}
        </table>
      </td></tr>`;

  const tallyRow = tallyLine === null
    ? ''
    : `<tr><td style="padding:12px 0; font-size:13px; color:#555;">
        Since midnight: ${totalSinceMidnight} ${totalSinceMidnight === 1 ? 'article' : 'articles'} ·
        ${tagTally.map((t) => `<span style="color:#0066ff;">#${escapeHtml(t.tag)}</span> (${t.count})`).join(' &nbsp; ')}
      </td></tr>`;

  const sentRow = `<tr><td style="padding:8px 0 24px; font-size:12px; color:#888;">
        ${escapeHtml(sentLine)}
      </td></tr>`;

  const ctaRow = `<tr><td style="padding-bottom:24px;">
        <a href="${safeAppUrlAttr}/digest" style="display:inline-block; padding:14px 28px; background:#0066ff; color:#fff; text-decoration:none; font-weight:600; border-radius:6px;">View your dashboard →</a>
      </td></tr>`;

  const footerRow = `<tr><td style="padding:24px 0 8px; border-top:1px solid #eee; font-size:12px; color:#888;">
        <a href="${safeSettingsUrlAttr}" style="color:#888;">Manage notifications →</a>
      </td></tr>`;

  const signatureRow = `<tr><td style="padding-top:8px; font-size:13px; color:#888;">
        <a href="${escapeHtml(GRAY_MATTER_URL)}" style="color:#888; text-decoration:none;">— Gray Matter</a>
      </td></tr>`;

  const greetingRow = headlines.length === 0
    ? `<tr><td style="padding-bottom:24px; font-size:18px; line-height:1.5;">Your news digest is ready.</td></tr>`
    : `<tr><td style="padding-bottom:16px; font-size:18px; line-height:1.5;">
         Your news digest is ready — ${headlines.length} new articles to read.
       </td></tr>`;

  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:48px 24px; background:#fafafa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif; color:#111;">
    <div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" style="max-width:560px; margin:0 auto;">
      ${greetingRow}
      ${headlineRows}
      ${tallyRow}
      ${ctaRow}
      ${sentRow}
      ${footerRow}
      ${signatureRow}
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

/** Inputs to {@link sendEmail}. The caller pre-renders subject/text/html
 * so the transport stays template-agnostic. */
export interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Outcome of a send attempt. Never throws — callers branch on `sent`.
 *
 *  `resend_not_configured` is the fork-friendly "no email creds in this
 *  deployment" signal: digests still generate but no email goes out. */
export interface SendEmailResult {
  sent: boolean;
  error_code?: 'resend_non_2xx' | 'resend_error' | 'resend_not_configured';
}

/**
 * Transport: POST the rendered email to Resend. Best-effort — never
 * re-throws. Failure modes:
 *   - Non-2xx response → `{ sent: false, error_code: 'resend_non_2xx' }`
 *     and an `email.send.failed` log with the HTTP status + Resend's
 *     short diagnostic.
 *   - Thrown fetch error (network, DNS, timeout) →
 *     `{ sent: false, error_code: 'resend_error' }` and an
 *     `email.send.failed` log with the error message.
 */
export async function sendEmail(
  env: Env,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  // Short-circuit when Resend isn't configured. A fork that only wants
  // the in-app digest (no email) sets neither secret; the deploy
  // workflow skips the wrangler secret put step, so both env vars
  // arrive here as undefined / empty. We return a clean
  // not_configured outcome instead of issuing a fetch with an empty
  // Bearer token (which would 401 and noise up the logs).
  //
  // Log once per send so a fork operator who expects emails to land
  // (but forgot to set the secrets) can see WHY no message went out
  // in `wrangler tail`. Severity is `info` — this is configuration,
  // not failure.
  if (
    typeof env.RESEND_API_KEY !== 'string' ||
    env.RESEND_API_KEY === '' ||
    typeof env.RESEND_FROM !== 'string' ||
    env.RESEND_FROM === ''
  ) {
    log('info', 'email.send.failed', {
      to: params.to,
      status: null,
      error: 'resend_not_configured',
    });
    return { sent: false, error_code: 'resend_not_configured' };
  }

  const payload = {
    from: env.RESEND_FROM,
    to: [params.to],
    subject: params.subject,
    html: params.html,
    text: params.text,
    tags: [{ name: 'kind', value: 'daily-digest' }],
  };

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    log('error', 'email.send.failed', {
      to: params.to,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, error_code: 'resend_error' };
  }

  if (!response.ok) {
    let resendDetail = '';
    try {
      resendDetail = (await response.text()).slice(0, 500);
    } catch {
      /* body read failure — non-fatal */
    }
    log('error', 'email.send.failed', {
      to: params.to,
      status: response.status,
      resend_detail: resendDetail,
    });
    return { sent: false, error_code: 'resend_non_2xx' };
  }

  return { sent: true };
}
