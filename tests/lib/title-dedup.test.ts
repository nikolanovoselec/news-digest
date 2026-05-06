import { describe, it, expect } from 'vitest';
import { mergeBySameSourceTitleSimilarity } from '~/lib/title-dedup';
import type { Candidate, Cluster } from '~/lib/dedupe';

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    canonical_url: 'https://example.com/a',
    source_url: 'https://example.com/a',
    source_name: 'Example Source',
    title: 'Untitled',
    published_at: 1_700_000_000,
    ...overrides,
  };
}

function cluster(c: Candidate): Cluster {
  return { primary: c, alternatives: [] };
}

describe('mergeBySameSourceTitleSimilarity', () => {
  it('REQ-PIPE-003: empty input is a no-op', () => {
    expect(mergeBySameSourceTitleSimilarity([])).toEqual([]);
  });

  it('REQ-PIPE-003: single cluster passes through unchanged', () => {
    const only = cluster(candidate({ title: 'Anthropic launches AI agents' }));
    const result = mergeBySameSourceTitleSimilarity([only]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(only);
  });

  it('REQ-PIPE-003: merges three same-source same-day rewrites of one Anthropic launch', () => {
    // The exact production case from scrape run 01KQZ0A6PKNP56H7B9MP1CWQS8.
    const a = cluster(
      candidate({
        canonical_url: 'https://news.google.com/articles/aaa',
        title: 'Anthropic Launches Bank-Friendly AI Agents and Vendor Partnerships',
        source_name: 'Google News - Anthropic',
        published_at: 1_778_080_000,
      }),
    );
    const b = cluster(
      candidate({
        canonical_url: 'https://news.google.com/articles/bbb',
        title: 'Anthropic Deploys AI Agents to Automate Tedious Wall Street Tasks',
        source_name: 'Google News - Anthropic',
        published_at: 1_778_080_500,
      }),
    );
    const c = cluster(
      candidate({
        canonical_url: 'https://news.google.com/articles/ccc',
        title: 'Anthropic Rolls Out Financial-Service-Specific AI Agents',
        source_name: 'Google News - Anthropic',
        published_at: 1_778_081_000,
      }),
    );

    const result = mergeBySameSourceTitleSimilarity([a, b, c]);
    expect(result).toHaveLength(1);
    // Earliest publish wins as merged primary.
    expect(result[0]?.primary.canonical_url).toBe('https://news.google.com/articles/aaa');
    expect(result[0]?.alternatives).toHaveLength(2);
  });

  it('REQ-PIPE-003: never merges across different source names', () => {
    const a = cluster(
      candidate({
        canonical_url: 'https://x/aa',
        title: 'Anthropic Launches Bank-Friendly AI Agents',
        source_name: 'Google News - Anthropic',
      }),
    );
    const b = cluster(
      candidate({
        canonical_url: 'https://y/bb',
        title: 'Anthropic Launches Bank-Friendly AI Agents',
        source_name: 'TechCrunch',
      }),
    );

    const result = mergeBySameSourceTitleSimilarity([a, b]);
    expect(result).toHaveLength(2);
  });

  it('REQ-PIPE-003: does not merge same-source items published more than 24h apart', () => {
    const a = cluster(
      candidate({
        canonical_url: 'https://x/aa',
        title: 'Anthropic Launches Financial AI Agents',
        source_name: 'Google News - Anthropic',
        published_at: 1_778_000_000,
      }),
    );
    const b = cluster(
      candidate({
        canonical_url: 'https://x/bb',
        title: 'Anthropic Launches Financial AI Agents',
        source_name: 'Google News - Anthropic',
        published_at: 1_778_000_000 + 25 * 60 * 60,
      }),
    );

    const result = mergeBySameSourceTitleSimilarity([a, b]);
    expect(result).toHaveLength(2);
  });

  it('REQ-PIPE-003: leaves topically-different same-source articles alone', () => {
    const a = cluster(
      candidate({
        canonical_url: 'https://x/aa',
        title: 'Anthropic Launches Financial AI Agents',
        source_name: 'Google News - Anthropic',
      }),
    );
    const b = cluster(
      candidate({
        canonical_url: 'https://x/bb',
        title: 'Anthropic Hires New Chief Privacy Officer',
        source_name: 'Google News - Anthropic',
      }),
    );

    const result = mergeBySameSourceTitleSimilarity([a, b]);
    expect(result).toHaveLength(2);
  });

  it('REQ-PIPE-003: source-name tokens do not falsely boost similarity', () => {
    // Both titles share "Anthropic" only because the source_name dictates it -
    // the rest of the vocabulary is disjoint. Must not merge.
    const a = cluster(
      candidate({
        canonical_url: 'https://x/aa',
        title: 'Anthropic Hires New Chief Privacy Officer',
        source_name: 'Google News - Anthropic',
      }),
    );
    const b = cluster(
      candidate({
        canonical_url: 'https://x/bb',
        title: 'Anthropic Opens Dublin Office Tomorrow',
        source_name: 'Google News - Anthropic',
      }),
    );

    const result = mergeBySameSourceTitleSimilarity([a, b]);
    expect(result).toHaveLength(2);
  });

  it('REQ-PIPE-003: transitively-similar clusters collapse into one group', () => {
    const a = cluster(
      candidate({
        canonical_url: 'https://x/aa',
        title: 'Vendor Releases Major Database Update',
        source_name: 'DB News',
      }),
    );
    const b = cluster(
      candidate({
        canonical_url: 'https://x/bb',
        title: 'Vendor Releases Database Update With Major Changes',
        source_name: 'DB News',
      }),
    );
    const c = cluster(
      candidate({
        canonical_url: 'https://x/cc',
        title: 'Database Update Brings Major Changes For Vendor Users',
        source_name: 'DB News',
      }),
    );

    const result = mergeBySameSourceTitleSimilarity([a, b, c]);
    expect(result).toHaveLength(1);
    expect(result[0]?.alternatives).toHaveLength(2);
  });

  it('REQ-PIPE-003: preserves alternatives from input clusters when merging', () => {
    const aPrimary = candidate({
      canonical_url: 'https://x/aa',
      title: 'Vendor Releases Database Update',
      source_name: 'DB News',
    });
    const aAlt = candidate({
      canonical_url: 'https://x/aa-alt',
      source_url: 'https://example.com/aa-alt',
      title: 'Vendor Releases Database Update',
      source_name: 'DB News',
    });
    const a: Cluster = { primary: aPrimary, alternatives: [aAlt] };
    const b = cluster(
      candidate({
        canonical_url: 'https://x/bb',
        title: 'Database Update From Vendor Brings Major Changes',
        source_name: 'DB News',
      }),
    );

    const result = mergeBySameSourceTitleSimilarity([a, b]);
    expect(result).toHaveLength(1);
    // The original alternative is preserved alongside the merged-in primary
    // of cluster b.
    expect(result[0]?.alternatives).toHaveLength(2);
    const altUrls = result[0]?.alternatives.map((c) => c.canonical_url) ?? [];
    expect(altUrls).toContain('https://x/aa-alt');
    expect(altUrls).toContain('https://x/bb');
  });
});
