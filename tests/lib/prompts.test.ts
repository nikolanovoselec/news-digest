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
    expect(LLM_PARAMS.max_tokens).toBe(8192);
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
    { title: 'Example', url: 'https://example.com/a', source_name: 'hn' },
    { title: 'Another', url: 'https://example.com/b', source_name: 'rss' },
  ];

  it('REQ-GEN-005: digestUserPrompt fences hashtags with triple backticks', () => {
    const prompt = digestUserPrompt(['cloudflare', 'ai'], sampleHeadlines);
    // Non-greedy match of a triple-backtick fenced block containing both tags.
    const fenceRe = /```[\s\S]*?cloudflare[\s\S]*?ai[\s\S]*?```/;
    expect(prompt).toMatch(fenceRe);
  });

  it('REQ-GEN-005: digestUserPrompt fences headlines with triple backticks', () => {
    const prompt = digestUserPrompt(['cloudflare'], sampleHeadlines);
    // JSON.stringify output for the headlines array must appear inside a fenced block.
    const serialized = JSON.stringify(sampleHeadlines);
    expect(prompt).toContain(serialized);
    // Generic triple-backtick fence containing the serialized JSON.
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
    // The prompt must tell the model what to return.
    expect(prompt).toContain('articles');
    expect(prompt).toContain('one_liner');
    expect(prompt).toContain('details');
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
