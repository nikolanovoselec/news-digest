// Tests for src/lib/email.ts `renderDigestReadyEmail` — REQ-MAIL-001.
//
// Wave 2 simplification: the email is a bare notification — one subject,
// one link to /digest, no per-article content, no cost/token footer, no
// tag summary, no article count. The renderer's entire surface is:
//   input:  { appUrl, userDisplayName }
//   output: { subject, text, html }
//
// These tests pin the observable shape of that output. They deliberately
// over-assert the *absence* of per-article content (title, summary,
// article count, tag summary, cost footer) so a regression that pulls
// those back into the template trips the suite.

import { describe, it, expect } from 'vitest';
import {
  renderDigestReadyEmail,
  type DigestReadyEmailParams,
} from '~/lib/email';

/** Build a plausible params object with overridable fields. */
function makeParams(
  overrides: Partial<DigestReadyEmailParams> = {},
): DigestReadyEmailParams {
  return {
    appUrl: 'https://news-digest.example.com',
    userDisplayName: 'alice',
    ...overrides,
  };
}

describe('renderDigestReadyEmail — REQ-MAIL-001', () => {
  it('REQ-MAIL-001: subject is the exact "Your news digest is ready" string', () => {
    const { subject } = renderDigestReadyEmail(makeParams());
    expect(subject).toBe('Your news digest is ready');
  });

  it('REQ-MAIL-001: subject does not include an article count or tag summary', () => {
    const { subject } = renderDigestReadyEmail(
      makeParams({ userDisplayName: 'bob' }),
    );
    // No middle-dot, no "N stories", no hashtag list.
    expect(subject).not.toMatch(/\d+\s+stor/i);
    expect(subject).not.toContain('\u00b7');
    expect(subject).not.toContain('#');
  });

  it('REQ-MAIL-001: text body contains a single link to /digest', () => {
    const { text } = renderDigestReadyEmail(
      makeParams({ appUrl: 'https://news-digest.example.com' }),
    );
    const link = 'https://news-digest.example.com/digest';
    const occurrences = text.split(link).length - 1;
    expect(occurrences).toBe(1);
  });

  it('REQ-MAIL-001: text body trims trailing slashes from appUrl', () => {
    const { text } = renderDigestReadyEmail(
      makeParams({ appUrl: 'https://news-digest.example.com/' }),
    );
    expect(text).toContain('https://news-digest.example.com/digest');
    expect(text).not.toContain('//digest');
  });

  it('REQ-MAIL-001: text body does not contain per-article fields', () => {
    const { text } = renderDigestReadyEmail(makeParams());
    // No article titles, no tag lists, no "N stories" counter, no cost
    // footer, no model name, no execution time.
    expect(text).not.toMatch(/\d+\s+stor/i);
    expect(text).not.toMatch(/tokens?/i);
    expect(text).not.toMatch(/\$?\d+\.\d{4}/); // cost-style number
    expect(text).not.toMatch(/\bms\b/);
    expect(text).not.toContain('#');
    expect(text).not.toContain('llama');
    expect(text).not.toContain('gpt');
  });

  it('REQ-MAIL-001: text body does not contain HTML tags', () => {
    const { text } = renderDigestReadyEmail(makeParams());
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('REQ-MAIL-001: html body contains a single <a> linking to /digest', () => {
    const { html } = renderDigestReadyEmail(
      makeParams({ appUrl: 'https://news-digest.example.com' }),
    );
    const anchors = html.match(/<a\b[^>]*>/gi) ?? [];
    expect(anchors).toHaveLength(1);
    expect(html).toContain('href="https://news-digest.example.com/digest"');
  });

  it('REQ-MAIL-001: html body trims trailing slashes from appUrl', () => {
    const { html } = renderDigestReadyEmail(
      makeParams({ appUrl: 'https://news-digest.example.com/' }),
    );
    expect(html).toContain('href="https://news-digest.example.com/digest"');
    expect(html).not.toContain('//digest');
  });

  it('REQ-MAIL-001: html body does not contain per-article fields', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).not.toMatch(/\d+\s+stor/i);
    expect(html).not.toMatch(/tokens?/i);
    expect(html).not.toMatch(/\$?\d+\.\d{4}/);
    expect(html).not.toContain('#');
    expect(html).not.toContain('llama');
    expect(html).not.toContain('gpt');
  });

  it('REQ-MAIL-001: html body does not reference article titles, summaries, or counts', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    // Generic regressions: article list markers should never appear.
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('<h3');
  });

  it('REQ-MAIL-001: html body has no <script> anywhere', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).not.toMatch(/<script\b/i);
  });

  it('REQ-MAIL-001: html body has no <style> blocks (styles are inlined)', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).not.toMatch(/<style\b/i);
  });

  it('REQ-MAIL-001: html escapes HTML metacharacters that appear in appUrl', () => {
    // Defense-in-depth: the caller supplies appUrl from env.APP_URL
    // (trusted config), but a stray quote must not break out of the
    // href attribute.
    const { html } = renderDigestReadyEmail(
      makeParams({ appUrl: 'https://evil"<x>&example.com' }),
    );
    expect(html).not.toContain('"<x>&example');
    expect(html).toContain('&quot;');
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('&amp;');
  });

  it('REQ-MAIL-001: return shape is { subject, text, html } with string values', () => {
    const rendered = renderDigestReadyEmail(makeParams());
    expect(typeof rendered.subject).toBe('string');
    expect(typeof rendered.text).toBe('string');
    expect(typeof rendered.html).toBe('string');
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.html.length).toBeGreaterThan(0);
  });
});
