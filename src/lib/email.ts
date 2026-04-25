// Implements REQ-MAIL-001
//
// Resend-backed transactional email for the global-feed rework.
//
// Wave 2 simplification: the email is a bare "your digest is ready"
// notification — a single subject line, a single link to the dashboard,
// no per-article content, no cost/token footer, no tag summary. The
// long-form content lives on /digest; the email's only job is to poke
// the user to come back.
//
// Split of concerns:
//   - `renderDigestReadyEmail` builds the static subject/text/html body
//     from a tiny input shape ({ appUrl, userDisplayName }).
//   - `sendEmail` is the transport: POSTs to Resend with the pre-rendered
//     subject/text/html and returns a structured result. Never re-throws
//     — email is best-effort and a Resend outage must not block the cron.
//
// HTML escaping: the only user-derived value interpolated into the HTML
// is `appUrl`, which the caller supplies from `env.APP_URL` (trusted
// config, not user input). We still escape it defensively so a stray
// quote or angle bracket cannot break out of the attribute context.
//
// Secrets hygiene (CON-SEC-001): `env.RESEND_API_KEY` is never logged,
// nor are full HTML/text bodies. `email.send.failed` logs carry only
// the recipient + HTTP status + Resend's short diagnostic — enough to
// triage, not enough to leak content.

import { log } from '~/lib/log';

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

/**
 * Inputs required to render the digest-ready notification. `appUrl` is
 * the site origin (e.g. `https://news.graymatter.ch`); the renderer
 * strips trailing slashes so "…/digest" never becomes "…//digest".
 * `userDisplayName` is not currently rendered (the template is intentionally
 * generic) but is part of the public shape so future personalisation
 * does not require an interface change.
 */
export interface DigestReadyEmailParams {
  appUrl: string;
  userDisplayName: string;
}

/** Subject/body triple returned by {@link renderDigestReadyEmail}. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Render the minimal "digest is ready" notification. Identical subject
 * for every recipient; the only varying input is `appUrl` (which drives
 * the CTA target).
 */
export function renderDigestReadyEmail(params: DigestReadyEmailParams): RenderedEmail {
  const appUrl = params.appUrl.replace(/\/+$/, '');
  const digestHref = `${appUrl}/digest`;
  const safeHref = escapeHtml(digestHref);

  const subject = 'Your news digest is ready';

  const text = [
    'Your news digest is ready.',
    '',
    `View it here: ${digestHref}`,
    '',
    '— Gray Matter',
    '',
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:48px 24px; background:#fafafa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif; color:#111;">
    <table role="presentation" width="100%" style="max-width:480px; margin:0 auto;">
      <tr><td style="padding-bottom:24px; font-size:18px; line-height:1.5;">Your news digest is ready.</td></tr>
      <tr><td style="padding-bottom:32px;"><a href="${safeHref}" style="display:inline-block; padding:14px 28px; background:#0066ff; color:#fff; text-decoration:none; font-weight:600; border-radius:6px;">View it on your dashboard →</a></td></tr>
      <tr><td style="font-size:13px; color:#888;">— Gray Matter</td></tr>
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
