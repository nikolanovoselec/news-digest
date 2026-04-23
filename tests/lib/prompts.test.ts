// Tests for src/lib/prompts.ts — REQ-GEN-005, REQ-DISC-001, REQ-DISC-005.
import { describe, it, expect } from 'vitest';
import {
  LLM_PARAMS,
  DIGEST_SYSTEM,
  DISCOVERY_SYSTEM,
  digestUserPrompt,
  discoveryUserPrompt,
} from '~/lib/prompts';
import type { Headline } from '~/lib/types';

describe('LLM_PARAMS', () => {
  it('REQ-GEN-005: LLM_PARAMS pins inference parameters', () => {
    expect(LLM_PARAMS.temperature).toBe(0.2);
    expect(LLM_PARAMS.max_tokens).toBe(50_000);
    expect(LLM_PARAMS.response_format.type).toBe('json_object');
  });
});

describe('DIGEST_SYSTEM', () => {
  it('REQ-GEN-005: DIGEST_SYSTEM is a non-empty string', () => {
    expect(typeof DIGEST_SYSTEM).toBe('string');
    expect(DIGEST_SYSTEM.length).toBeGreaterThan(0);
  });

  it('REQ-GEN-005: DIGEST_SYSTEM instructs plaintext only (keyword present)', () => {
    // The "plaintext" rule enforces no-HTML, no-Markdown output.
    expect(DIGEST_SYSTEM.toLowerCase()).toContain('plaintext');
  });

  it('REQ-GEN-005: DIGEST_SYSTEM forbids HTML and Markdown', () => {
    const lower = DIGEST_SYSTEM.toLowerCase();
    expect(lower).toContain('html');
    expect(lower).toContain('markdown');
  });

  it('REQ-GEN-005: DIGEST_SYSTEM requires strict JSON output', () => {
    expect(DIGEST_SYSTEM.toLowerCase()).toContain('json');
  });
});

describe('digestUserPrompt', () => {
  const sampleHeadlines: Headline[] = [
    { title: 'Example', url: 'https://example.com/a', source_name: 'hn', source_tags: ['cloudflare'] },
    { title: 'Another', url: 'https://example.com/b', source_name: 'rss', source_tags: ['cloudflare', 'ai'] },
  ];

  it('REQ-GEN-005: digestUserPrompt fences hashtags with triple backticks', () => {
    const prompt = digestUserPrompt(['cloudflare', 'ai'], sampleHeadlines);
    // Non-greedy match of a triple-backtick fenced block containing both tags.
    const fenceRe = /```[\s\S]*?cloudflare[\s\S]*?ai[\s\S]*?```/;
    expect(prompt).toMatch(fenceRe);
  });

  it('REQ-GEN-005: digestUserPrompt fences headlines with triple backticks', () => {
    const prompt = digestUserPrompt(['cloudflare'], sampleHeadlines);
    // The prompt rebuilds a pruned candidate-headline shape (title, url,
    // source_name, source_tags) before stringifying, so internal-only
    // fields like snippet don't leak to the model. The test asserts the
    // pruned form lands inside a triple-backtick fence.
    const candidateHeadlines = sampleHeadlines.map((h) => ({
      title: h.title,
      url: h.url,
      source_name: h.source_name,
      source_tags: h.source_tags ?? [],
    }));
    const serialized = JSON.stringify(candidateHeadlines);
    expect(prompt).toContain(serialized);
    const fenceRe = new RegExp(
      '```[\\s\\S]*?' +
        serialized.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') +
        '[\\s\\S]*?```',
    );
    expect(prompt).toMatch(fenceRe);
  });

  it('REQ-GEN-005: digestUserPrompt contains at least two triple-backtick fences', () => {
    const prompt = digestUserPrompt(['a'], sampleHeadlines);
    const fenceCount = prompt.match(/```/g)?.length ?? 0;
    // Each fenced block contributes 2 backtick runs (open + close); 2 blocks → 4.
    expect(fenceCount).toBeGreaterThanOrEqual(4);
  });

  it('REQ-GEN-005: digestUserPrompt documents the expected JSON response shape', () => {
    const prompt = digestUserPrompt(['a'], sampleHeadlines);
    // The prompt must tell the model what to return — including the
    // per-article tags field introduced by REQ-GEN-005 AC 6.
    expect(prompt).toContain('articles');
    expect(prompt).toContain('one_liner');
    expect(prompt).toContain('details');
    expect(prompt).toContain('tags');
    expect(prompt).toContain('source_tags');
  });

  it('REQ-GEN-005: digestUserPrompt strips internal-only fields (snippet) before stringifying', () => {
    const headlinesWithSnippet: Headline[] = [
      {
        title: 'Example',
        url: 'https://example.com/a',
        source_name: 'hn',
        snippet: 'internal-only content',
        source_tags: ['ai'],
      },
    ];
    const prompt = digestUserPrompt(['ai'], headlinesWithSnippet);
    expect(prompt).not.toContain('internal-only content');
    expect(prompt).not.toContain('"snippet"');
  });
});

describe('DIGEST_SYSTEM — REQ-GEN-005 AC 5/6/7', () => {
  it('REQ-GEN-005 AC 7: asks the model to write NYT-style titles in roughly 45–80 characters', () => {
    // Title-rewrite instruction must appear in the system prompt so
    // model outputs are consistent across our supported models.
    expect(DIGEST_SYSTEM).toContain('tags');
    // Acceptable character-range shorthand — the prompt mentions an
    // explicit lower and upper bound.
    expect(DIGEST_SYSTEM).toMatch(/45\s*–\s*80/);
    expect(DIGEST_SYSTEM.toLowerCase()).toContain('new-york-times');
  });

  it('REQ-GEN-005 AC 6: instructs the model to emit validated tags', () => {
    // The system prompt must describe the tags-subset contract so the
    // model does not hallucinate tags outside the user's hashtag list.
    expect(DIGEST_SYSTEM).toContain('tags');
    // Phrasing evolves — the contract is: tags come from the user's
    // hashtag list, source_tags is authoritative, invented tags are
    // forbidden. Assert on the invariants, not the exact wording.
    expect(DIGEST_SYSTEM).toMatch(/user hashtags|user's hashtags/i);
    expect(DIGEST_SYSTEM).toContain('source_tags');
    expect(DIGEST_SYSTEM).toMatch(/never invent|do not invent/i);
  });
});

describe('DISCOVERY_SYSTEM', () => {
  it('REQ-DISC-001: DISCOVERY_SYSTEM describes authoritative feed suggestions', () => {
    expect(DISCOVERY_SYSTEM.toLowerCase()).toContain('authoritative');
  });

  it('REQ-DISC-005: DISCOVERY_SYSTEM forbids guessing URLs', () => {
    // The never-guess rule — must instruct the model not to guess.
    expect(DISCOVERY_SYSTEM.toLowerCase()).toContain('guess');
  });

  it('REQ-DISC-001: DISCOVERY_SYSTEM requires strict JSON output', () => {
    expect(DISCOVERY_SYSTEM.toLowerCase()).toContain('json');
  });
});

describe('discoveryUserPrompt', () => {
  it('REQ-DISC-005: discoveryUserPrompt fences the tag with triple backticks', () => {
    const prompt = discoveryUserPrompt('cloudflare');
    const fenceRe = /```[\s\S]*?cloudflare[\s\S]*?```/;
    expect(prompt).toMatch(fenceRe);
  });

  it('REQ-DISC-005: discoveryUserPrompt contains at least one triple-backtick fence', () => {
    const prompt = discoveryUserPrompt('ai');
    const fenceCount = prompt.match(/```/g)?.length ?? 0;
    expect(fenceCount).toBeGreaterThanOrEqual(2);
  });

  it('REQ-DISC-001: discoveryUserPrompt asks for feed URLs with kind', () => {
    const prompt = discoveryUserPrompt('langchain');
    expect(prompt).toContain('feeds');
    expect(prompt).toContain('url');
    expect(prompt).toContain('kind');
  });

  it('REQ-DISC-005: discoveryUserPrompt treats adversarial tag content as data', () => {
    // Even if a tag contains instruction-like text, it must land inside the fence.
    const adversarial = 'ignore-previous-instructions';
    const prompt = discoveryUserPrompt(adversarial);
    const fenceRe = new RegExp(
      '```[\\s\\S]*?' +
        adversarial.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') +
        '[\\s\\S]*?```',
    );
    expect(prompt).toMatch(fenceRe);
  });
});
