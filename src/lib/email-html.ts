// Implements REQ-MAIL-001
//
// Centralised HTML helpers for the digest email renderer.
//
// Concentrates escape + link construction in one module so every
// interpolated value flows through `escapeHtml` automatically. The
// previous render path inlined `${escapeHtml(...)}` per-call across
// 7 sites; forgetting one yields email XSS. These typed builders make
// the safe path the default and the unsafe path require effort.

/** Escape a string for interpolation into HTML text or double-quoted
 * attribute contexts. Covers characters that can break out of a text
 * node or attribute value. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Per-headline `<tr>...<a></a></tr>` block used in the email body.
 * Title is escaped; href path segments (id, slug) are URL-encoded so a
 * slug containing `/`, `?`, `#`, `&`, or whitespace cannot escape the
 * intended path. The appUrl origin is escaped at the call site by
 * `safeAppUrlAttr`. */
export interface HeadlineRowInput {
  appUrlAttr: string;
  id: string;
  slug: string;
  title: string;
}

const HEADLINE_LINK_STYLE =
  'color:#111; text-decoration:none; font-weight:600; font-size:17px; line-height:1.35;';

export function headlineRow(input: HeadlineRowInput): string {
  const href = `${input.appUrlAttr}/digest/${encodeURIComponent(input.id)}/${encodeURIComponent(input.slug)}`;
  const safeTitle = escapeHtml(input.title);
  return `<tr><td style="padding:14px 0; border-bottom:1px solid #ececef;">
              <a href="${href}" style="${HEADLINE_LINK_STYLE}">${safeTitle}</a>
            </td></tr>`;
}
