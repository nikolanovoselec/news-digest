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
  it('REQ-SET-004: DEFAULT_MODEL_ID is @cf/openai/gpt-oss-20b — native OpenAI JSON mode, not a reasoning model', () => {
    // Gemma-4 (the prior default) is a reasoning model: it emits
    // chain-of-thought into choices[0].message.reasoning and only
    // writes final JSON to .content AFTER reasoning completes. With
    // a 100-article chunk the chain-of-thought ate the entire
    // max_tokens budget before producing any JSON → every call
    // returned content=null → chunks failed and dead-lettered.
    // gpt-oss-20b honors response_format: json_object as a HARD
    // contract and never emits reasoning side-channel output.
    expect(DEFAULT_MODEL_ID).toBe('@cf/openai/gpt-oss-20b');
  });

  it('REQ-SET-004: DEFAULT_MODEL_ID is present in MODELS', () => {
    const found = MODELS.find((m) => m.id === DEFAULT_MODEL_ID);
    expect(found).toBeDefined();
    expect(found?.category).toBe('featured');
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
    // gpt-oss-20b: input $0.20 / output $0.30 per Mtok.
    // 1,000,000 in → $0.20; 1,000,000 out → $0.30; total $0.50.
    const cost = estimateCost(DEFAULT_MODEL_ID, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.50, 6);
  });

  it('REQ-SET-004: estimateCost scales linearly with token counts', () => {
    // 2,000 input tokens × $0.20/Mtok → $0.0004
    // 1,000 output tokens × $0.30/Mtok → $0.0003
    // total ≈ $0.0007
    const cost = estimateCost(DEFAULT_MODEL_ID, 2_000, 1_000);
    expect(cost).toBeCloseTo(0.0007, 9);
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
      category: 'budget',
    };
    expect(sample.category).toBe('budget');
  });
});
