// Tests for src/lib/prompts.ts — REQ-GEN-005, REQ-DISC-001, REQ-DISC-005,
// and REQ-PIPE-002 (chunk processing).
import { describe, it, expect } from 'vitest';
import {
  LLM_PARAMS,
  DIGEST_SYSTEM,
  DISCOVERY_SYSTEM,
  PROCESS_CHUNK_SYSTEM,
  digestUserPrompt,
  discoveryUserPrompt,
  processChunkUserPrompt,
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

describe('PROCESS_CHUNK_SYSTEM + processChunkUserPrompt — REQ-PIPE-002', () => {
  const sampleCandidates = [
    {
      index: 0,
      title: 'Cloudflare ships Workers AI upgrade',
      url: 'https://blog.cloudflare.com/workers-ai-upgrade',
      source_name: 'Cloudflare Blog',
      published_at: 1713_900_000,
      body_snippet: 'Snippet A',
    },
    {
      index: 1,
      title: 'AWS re:Invent announces Bedrock',
      url: 'https://aws.amazon.com/blog/bedrock',
      source_name: 'AWS News',
      published_at: 1713_900_100,
    },
  ];

  it('REQ-PIPE-002: PROCESS_CHUNK_SYSTEM is a non-empty exported string', () => {
    expect(typeof PROCESS_CHUNK_SYSTEM).toBe('string');
    expect(PROCESS_CHUNK_SYSTEM.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-002: PROCESS_CHUNK_SYSTEM demands JSON output with articles + dedup_groups', () => {
    expect(PROCESS_CHUNK_SYSTEM.toLowerCase()).toContain('json');
    expect(PROCESS_CHUNK_SYSTEM).toContain('articles');
    expect(PROCESS_CHUNK_SYSTEM).toContain('dedup_groups');
  });

  it('REQ-PIPE-002: PROCESS_CHUNK_SYSTEM forbids inventing tags outside the allowlist', () => {
    const lower = PROCESS_CHUNK_SYSTEM.toLowerCase();
    // Either explicit prohibition ("do not invent") or a subset assertion
    // ("only from the allowlist") satisfies the contract.
    const forbidsInvention =
      /do not invent/i.test(PROCESS_CHUNK_SYSTEM) ||
      /never invent/i.test(PROCESS_CHUNK_SYSTEM);
    const subsetAssertion = lower.includes('allowlist');
    expect(forbidsInvention || subsetAssertion).toBe(true);
  });

  it('REQ-PIPE-002: PROCESS_CHUNK_SYSTEM instructs plaintext-only body output', () => {
    expect(PROCESS_CHUNK_SYSTEM.toLowerCase()).toContain('plaintext');
  });

  it('REQ-PIPE-002: processChunkUserPrompt injects the full tag allowlist', () => {
    const allowlist = ['cloudflare', 'ai', 'aws', 'kubernetes'];
    const prompt = processChunkUserPrompt(sampleCandidates, allowlist);
    for (const tag of allowlist) {
      expect(prompt).toContain(tag);
    }
  });

  it('REQ-PIPE-002: processChunkUserPrompt lists candidates with index-stable numbering', () => {
    const prompt = processChunkUserPrompt(sampleCandidates, ['cloudflare', 'aws']);
    expect(prompt).toContain('[0]');
    expect(prompt).toContain('[1]');
    expect(prompt).toContain('Cloudflare ships Workers AI upgrade');
    expect(prompt).toContain('AWS re:Invent announces Bedrock');
    // Order matters: [0] must appear before [1] in the rendered prompt.
    expect(prompt.indexOf('[0]')).toBeLessThan(prompt.indexOf('[1]'));
  });

  it('REQ-PIPE-002: processChunkUserPrompt fences untrusted candidate content with triple backticks', () => {
    const prompt = processChunkUserPrompt(sampleCandidates, ['cloudflare']);
    // At least two fences (allowlist + candidates) → ≥4 backtick runs.
    const fenceCount = prompt.match(/```/g)?.length ?? 0;
    expect(fenceCount).toBeGreaterThanOrEqual(4);
  });

  it('REQ-PIPE-002: processChunkUserPrompt forbids the LLM from inventing tags outside the allowlist', () => {
    const prompt = processChunkUserPrompt(sampleCandidates, ['cloudflare']);
    // The user message tells the model the output tags must be a subset
    // of the allowlist. Assert on the contract words, not exact phrasing.
    expect(prompt.toLowerCase()).toMatch(/allowlist|subset of|never invent/i);
  });

  it('REQ-PIPE-002: processChunkUserPrompt documents the expected JSON response shape', () => {
    const prompt = processChunkUserPrompt(sampleCandidates, ['cloudflare']);
    expect(prompt).toContain('articles');
    expect(prompt).toContain('title');
    expect(prompt).toContain('details');
    expect(prompt).toContain('tags');
    expect(prompt).toContain('dedup_groups');
  });
});
