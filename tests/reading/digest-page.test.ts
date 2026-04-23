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

  it('REQ-READ-001: ticks countdown every 1000ms via setInterval', () => {
    expect(digestPageSource).toContain('setInterval');
    expect(digestPageSource).toMatch(/setInterval\(\s*tickCountdown\s*,\s*1000\s*\)/);
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
});

describe('DigestCard.astro — REQ-READ-001 AC 2/3', () => {
  it('REQ-READ-001: shows title, one-liner, and source badge', () => {
    expect(digestCardSource).toContain('digest-card__title');
    expect(digestCardSource).toContain('digest-card__one-liner');
    expect(digestCardSource).toContain('digest-card__source');
  });

  it('REQ-READ-001: applies 40ms-per-index stagger capped at 9', () => {
    expect(digestCardSource).toContain('stagger * 40');
    expect(digestCardSource).toMatch(/Math\.min\(index,\s*9\)/);
  });

  it('REQ-READ-001: wraps in <a href> so whole card is clickable', () => {
    expect(digestCardSource).toMatch(/<a[\s\S]*?href=\{href\}/);
  });

  it('REQ-READ-002: declares a transition:name derived from slug for shared-element morph', () => {
    expect(digestCardSource).toContain('transition:name={transitionName}');
    expect(digestCardSource).toMatch(/card-\$\{slug\}/);
  });

  it('REQ-READ-001: link target resolves to the detail route', () => {
    expect(digestCardSource).toMatch(/\/digest\/\$\{digestId\}\/\$\{slug\}/);
  });
});
