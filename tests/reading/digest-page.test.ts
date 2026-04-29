// Tests for src/pages/digest.astro and its associated components —
// REQ-READ-001, REQ-READ-005.
//
// Astro pages can't be fully rendered in a vitest worker without the
// full Astro runtime, so we validate observable contract via `?raw`
// source imports (same pattern used in install-prompt.test.ts). The
// tests assert on the DOM hooks, class names, animation rules, and
// branch conditions that the client script relies on.

import { describe, it, expect } from 'vitest';

import digestPageSource from '../../src/pages/digest.astro?raw';
import digestCardSource from '../../src/components/DigestCard.astro?raw';

describe('digest.astro — REQ-READ-001 grid', () => {
  it('REQ-READ-001: implements REQ-READ-001 marker is present', () => {
    expect(digestPageSource).toContain('REQ-READ-001');
  });

  it('REQ-READ-001: implements REQ-READ-005 marker is present', () => {
    expect(digestPageSource).toContain('REQ-READ-005');
  });

  it('REQ-READ-001: responsive grid uses 1/2/3 columns at 640/768/1024 breakpoints', () => {
    expect(digestPageSource).toMatch(/grid-template-columns:\s*1fr/);
    expect(digestPageSource).toMatch(
      /@media\s*\(min-width:\s*768px\)[\s\S]*?grid-template-columns:\s*repeat\(2/,
    );
    expect(digestPageSource).toMatch(
      /@media\s*\(min-width:\s*1024px\)[\s\S]*?grid-template-columns:\s*repeat\(3/,
    );
  });

  it('REQ-READ-001: header contains "Last updated at" and "Next update in"', () => {
    expect(digestPageSource).toContain('Last updated at');
    expect(digestPageSource).toContain('Next update in');
  });

  it('REQ-READ-005: empty state reads "No news for you today, try adding additional tags."', () => {
    expect(digestPageSource).toContain(
      'No news for you today, try adding additional tags.',
    );
  });

  it('REQ-READ-001: iterates articles with index so stagger delay is per-card', () => {
    // Passing index to DigestCard is the mechanism that drives any
    // per-card staging (focus order, stagger preservation).
    expect(digestPageSource).toMatch(/index=\{i\}/);
  });

  it('REQ-READ-001: no Refresh button on the page', () => {
    expect(digestPageSource).not.toMatch(/data-refresh-button/);
    expect(digestPageSource).not.toContain('digest-page__refresh-button');
    expect(digestPageSource).not.toContain('handleRefresh');
  });

  it('REQ-READ-001: no PendingBanner / LoadingSkeleton imports', () => {
    expect(digestPageSource).not.toContain('PendingBanner');
    expect(digestPageSource).not.toContain('LoadingSkeleton');
  });

  it('REQ-READ-001: no stale live-state / poll hooks remain', () => {
    expect(digestPageSource).not.toContain('data-digest-poll');
    expect(digestPageSource).not.toContain('bindDigestPoll');
    expect(digestPageSource).not.toMatch(/\bisLive\b/);
    expect(digestPageSource).not.toMatch(/\bisReadyToday\b/);
    expect(digestPageSource).not.toContain('/digest/no-stories');
    expect(digestPageSource).not.toContain('/digest/failed');
  });

  it('REQ-READ-001: ticks countdown via setInterval (minutes-only format tolerates a 10-second cadence)', () => {
    // The countdown shows "Xm" / "Xh Ym" — no seconds — so a 10-second
    // tick interval is visually indistinguishable from a 1-second one
    // and cheaper (6x fewer re-renders per minute). Accept either
    // cadence (a future revert to 1s stays green), and accept the
    // tick callback being either a direct reference (`tickCountdown`)
    // or an arrow wrapper that also polls scrape-status — the
    // contract is "runs every 1s or 10s", not "is exactly these
    // three characters at the callsite".
    expect(digestPageSource).toContain('setInterval');
    expect(digestPageSource).toMatch(
      /setInterval\([\s\S]*?,\s*(?:1000|10_000|10000)\s*\)/,
    );
    expect(digestPageSource).toContain('tickCountdown');
  });

  it('REQ-READ-001: tears down interval on astro:before-swap', () => {
    expect(digestPageSource).toContain('astro:before-swap');
    expect(digestPageSource).toContain('clearInterval');
  });

  it('REQ-READ-001: countdown anchor is data-next-at populated from next_scrape_at', () => {
    expect(digestPageSource).toContain('data-next-at');
    expect(digestPageSource).toContain('next_scrape_at');
  });

  it('REQ-READ-001: offline banner stays wired off navigator.onLine', () => {
    expect(digestPageSource).toContain('navigator.onLine');
    expect(digestPageSource).toContain('data-offline-banner');
  });

  it('REQ-READ-001: tag-strip filter logic is preserved', () => {
    expect(digestPageSource).toContain('data-tag-strip');
    expect(digestPageSource).toContain('data-tag-chip');
    expect(digestPageSource).toContain('wireTagStrip');
  });

  it('REQ-READ-001: the stale strip.querySelector lookup for [data-tag-add] / [data-tag-add-input] is NOT reintroduced', () => {
    // Regression guard for the "clicking a tag doesn't select it"
    // bug. The +add button and its input were hoisted OUT of
    // `[data-tag-strip]` and now live as siblings inside
    // `[data-tag-strip-wrap]`. Querying them from the inner strip
    // always returned null → null-guard tripped → the chip/remove
    // click handler never bound.
    //
    // The positive assertion is fragile to renames (wrap → wrapEl),
    // so pin the NEGATION instead: the stale selector MUST NOT
    // reappear in the source. Any resurrection of the bug trips
    // this guard regardless of surrounding variable names.
    expect(digestPageSource).not.toMatch(
      /strip\.querySelector<HTMLButtonElement>\(\s*['"]\[data-tag-add\]['"]\s*\)/,
    );
    expect(digestPageSource).not.toMatch(
      /strip\.querySelector<HTMLInputElement>\(\s*['"]\[data-tag-add-input\]['"]\s*\)/,
    );
    // And confirm the wrapper element is referenced at least once
    // somewhere in the file, so the hoisted-outside-strip structure
    // isn't silently removed in a future refactor.
    expect(digestPageSource).toContain('data-tag-strip-wrap');
  });
});

describe('DigestCard.astro — REQ-READ-001 AC 2/3', () => {
  it('REQ-READ-001: shows title, one-liner, and source badge', () => {
    expect(digestCardSource).toContain('digest-card__title');
    expect(digestCardSource).toContain('digest-card__one-liner');
    expect(digestCardSource).toContain('digest-card__source');
  });

  it('REQ-READ-001: index prop is accepted as a no-op (stagger animation retired)', () => {
    // The per-card stagger animation was retired; `index` is kept
    // as a backward-compat no-op so existing callers don't need an
    // ordering churn. The clamp expression remains in source for the
    // exposed `data-stagger-index` attribute (used for focus-order
    // experiments). Per CF-016 the inline `style` attribute that
    // computed `--stagger-delay: ${stagger * 40}ms` was removed when
    // CSP `style-src 'self'` was enforced — that CSS variable had no
    // remaining consumers.
    expect(digestCardSource).toMatch(/Math\.min\(index,\s*9\)/);
    expect(digestCardSource).toContain('data-stagger-index={stagger}');
  });

  it('REQ-READ-001: wraps in <a href> so whole card is clickable', () => {
    expect(digestCardSource).toMatch(/<a[\s\S]*?href=\{href\}/);
  });

  it('REQ-READ-002: emits no default transition:name and exposes data-vt-slug for single-card promotion', () => {
    // The morph-shaping refactor strips the default `transition:name`
    // from every card. /history can render 100+ cards across opened
    // days, and the browser captures every named element on the page
    // as part of the view-transition pseudo tree — O(N) snapshot
    // bookkeeping for a morph that only ever pairs ONE card with the
    // article-detail header. The card carries `data-vt-slug={slug}`
    // so `src/scripts/page-effects.ts` can promote exactly one card
    // (the clicked one outbound, the matching one inbound) by setting
    // `view-transition-name: card-${slug}` at navigation time.
    expect(digestCardSource).not.toMatch(/transition:name=\{transitionName\}/);
    expect(digestCardSource).toMatch(/data-vt-slug=\{slug\}/);
  });

  it('REQ-READ-001: link target resolves to the detail route', () => {
    expect(digestCardSource).toMatch(/\/digest\/\$\{digestId\}\/\$\{slug\}/);
  });

  it('REQ-READ-001: # tag-trigger always shows the tag count (including "#1" for single-tag articles)', () => {
    // Pin the "#{tags.length}" form; the prior "#{tags.length > 1 ? tags.length : ''}"
    // hid the count for single-tag cards and made them look decoration-only.
    expect(digestCardSource).toMatch(/#\{tags\.length\}/);
    // Regression guard: the single-tag "hide the number" branch is gone.
    expect(digestCardSource).not.toMatch(
      /tags\.length\s*>\s*1\s*\?\s*tags\.length\s*:\s*['"]{2}/,
    );
  });

  it('REQ-STAR-001 / REQ-READ-001: star toggle and tag popover adopt the inverted-theme palette (bg=var(--text), fg=var(--bg))', () => {
    // Star: when aria-pressed='true' the button flips to a filled
    // inverted pill matching the # trigger.
    expect(digestCardSource).toMatch(
      /\.digest-card__star\[aria-pressed='true'\]\s*\{[^}]*background:\s*var\(--text\)[^}]*color:\s*var\(--bg\)/,
    );
    // Popover: inverted pill, not the prior card-style background.
    expect(digestCardSource).toMatch(
      /\.digest-card__tag-popover\s*\{[^}]*background:\s*var\(--text\)[^}]*color:\s*var\(--bg\)/,
    );
    // Chips inherit instead of hard-coding --text-muted, so the popover
    // palette flows through.
    expect(digestCardSource).toMatch(
      /\.digest-card__tag-chip\s*\{[^}]*color:\s*inherit/,
    );
  });
});

describe('digest.astro — REQ-READ-001 AC 5 "see today" tile', () => {
  it('REQ-READ-001 AC 5: a 30th grid slot is rendered after the article cards as a link to /history with today\'s local date', () => {
    // The tile must be inside the grid (after the articles.map) and
    // its href must be dynamically built from the server-computed
    // todayLocalDate so it resolves to the user's local calendar day.
    expect(digestPageSource).toContain('digest-page__more-card');
    expect(digestPageSource).toMatch(
      /href=\{`\/history\?date=\$\{todayLocalDate\}`\}/,
    );
    expect(digestPageSource).toContain('data-digest-more-tile');
  });

  it('REQ-READ-001 AC 5: tile uses the MDI gradient-vertical icon, centred, with no title/body text', () => {
    // The canonical MDI gradient-vertical path starts with M11,9H13V11...
    expect(digestPageSource).toContain('M11,9H13V11H11V9');
    // Icon must be centered in the card — flex with center justify.
    expect(digestPageSource).toMatch(
      /\.digest-page__more-card\s*\{[^}]*justify-content:\s*center/,
    );
    expect(digestPageSource).toMatch(
      /\.digest-page__more-card\s*\{[^}]*align-items:\s*center/,
    );
  });

  it('REQ-READ-001 AC 5: todayLocalDate is computed server-side from the user timezone, not hard-coded', () => {
    expect(digestPageSource).toContain('localDateInTz');
    expect(digestPageSource).toContain('todayLocalDate');
  });
});
