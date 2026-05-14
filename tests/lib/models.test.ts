// Tests for src/lib/models.ts — REQ-SET-004 (Workers AI model catalog).
import { describe, it, expect } from 'vitest';
import {
  MODELS,
  DEFAULT_MODEL_ID,
  modelById,
  estimateCost,
  type ModelOption,
} from '~/lib/models';

describe('MODELS catalog', () => {
  it('REQ-SET-004: MODELS array has at least 10 entries', () => {
    expect(MODELS.length).toBeGreaterThanOrEqual(10);
  });

  it('REQ-SET-004: MODELS entries all have the required shape', () => {
    for (const model of MODELS) {
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.name).toBe('string');
      expect(typeof model.description).toBe('string');
      expect(typeof model.inputPricePerMtok).toBe('number');
      expect(typeof model.outputPricePerMtok).toBe('number');
      expect(typeof model.contextTokens).toBe('number');
      expect(model.contextTokens).toBeGreaterThan(0);
      expect(['featured', 'budget']).toContain(model.category);
    }
  });

  it('REQ-SET-004: MODELS has at least 4 featured and at least 5 budget entries', () => {
    // Exact counts drift as the Workers AI catalog evolves + prices
    // move. The invariants that matter are (a) each tier has enough
    // options that the dropdown is worth rendering, and (b) every
    // entry carries a valid category.
    const featured = MODELS.filter((m) => m.category === 'featured');
    const budget = MODELS.filter((m) => m.category === 'budget');
    expect(featured.length).toBeGreaterThanOrEqual(4);
    expect(budget.length).toBeGreaterThanOrEqual(5);
  });

  it('REQ-SET-004: MODELS ids are unique', () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('DEFAULT_MODEL_ID', () => {
  it('REQ-SET-004: DEFAULT_MODEL_ID is @cf/openai/gpt-oss-20b — 128K context, native JSON, single-model arch', () => {
    // Swapped from gpt-oss-120b on 2026-05-14 (AD48) as part of the
    // dedup cost-reduction package. Same OpenAI family, same 128K
    // context, same native JSON mode at $0.20/$0.30 per Mtok versus
    // 120b's $0.35/$0.75. Rollback contract: flip this literal back
    // to '@cf/openai/gpt-oss-120b' if 20b regresses on chunk-sized
    // prompts (the Gemma 4 26B prompt-timeout failure mode from
    // 2026-05 is the comparison shape to watch on integration).
    expect(DEFAULT_MODEL_ID).toBe('@cf/openai/gpt-oss-20b');
  });

  it('REQ-SET-004: DEFAULT_MODEL_ID is present in MODELS', () => {
    const found = MODELS.find((m) => m.id === DEFAULT_MODEL_ID);
    expect(found).toBeDefined();
    expect(found?.category).toBe('featured');
    expect(found?.contextTokens).toBeGreaterThanOrEqual(128_000);
  });
});

describe('modelById', () => {
  it('REQ-SET-004: modelById returns the matching ModelOption', () => {
    const m = modelById(DEFAULT_MODEL_ID);
    expect(m).toBeDefined();
    expect(m?.id).toBe(DEFAULT_MODEL_ID);
  });

  it('REQ-SET-004: modelById returns undefined for an unknown id', () => {
    expect(modelById('invalid')).toBeUndefined();
    expect(modelById('@cf/does-not-exist/nope')).toBeUndefined();
    expect(modelById('')).toBeUndefined();
  });
});

describe('estimateCost', () => {
  it('REQ-SET-004: estimateCost computes USD from per-million-token prices', () => {
    // gpt-oss-20b: input $0.20 / output $0.30 per Mtok (AD48).
    // 1,000,000 in -> $0.20; 1,000,000 out -> $0.30; total $0.50.
    const cost = estimateCost(DEFAULT_MODEL_ID, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.50, 6);
  });

  it('REQ-SET-004: estimateCost scales linearly with token counts', () => {
    // 2,000 input tokens * $0.20/Mtok = $0.00040
    // 1,000 output tokens * $0.30/Mtok = $0.00030
    // total ~= $0.00070
    const cost = estimateCost(DEFAULT_MODEL_ID, 2_000, 1_000);
    expect(cost).toBeCloseTo(0.00070, 9);
  });

  it('REQ-SET-004: estimateCost is non-zero for Kimi K2.5 (published pricing)', () => {
    // Kimi K2.5: input $0.60 / output $3.00 per Mtok.
    const cost = estimateCost('@cf/moonshotai/kimi-k2.5', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(3.60, 6);
  });

  it('REQ-SET-004: estimateCost returns 0 for an unknown model id', () => {
    expect(estimateCost('invalid', 10_000, 10_000)).toBe(0);
  });

  it('REQ-SET-004: estimateCost returns 0 when both token counts are 0', () => {
    expect(estimateCost(DEFAULT_MODEL_ID, 0, 0)).toBe(0);
  });
});

// Satisfy isolatedModules: ensure the ModelOption type import is referenced.
describe('ModelOption type', () => {
  it('REQ-SET-004: ModelOption type is exported for consumers', () => {
    const sample: ModelOption = {
      id: 'x',
      name: 'x',
      description: 'x',
      inputPricePerMtok: 0,
      outputPricePerMtok: 0,
      contextTokens: 128_000,
      category: 'budget',
    };
    expect(sample.category).toBe('budget');
  });
});
