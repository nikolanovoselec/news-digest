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
  it('REQ-SET-004: DEFAULT_MODEL_ID is @cf/google/gemma-4-26b-a4b-it — 256K context, 3.5x cheaper output', () => {
    // Switched 2026-05-05: Gemma 4 26B's 256K context lets the chunk
    // packer carry full 15K-char long-form-essay snippets without
    // splitting; the price drop pays for the cron-tick budget at
    // scale. Earlier Gemma-class models undershot the 200-250 target;
    // Gemma 4 is a newer release tested against the current 150-200
    // word contract on integration first.
    expect(DEFAULT_MODEL_ID).toBe('@cf/google/gemma-4-26b-a4b-it');
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
    // gemma-4-26b-a4b-it: input $0.10 / output $0.30 per Mtok.
    // 1,000,000 in → $0.10; 1,000,000 out → $0.30; total $0.40.
    const cost = estimateCost(DEFAULT_MODEL_ID, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.40, 6);
  });

  it('REQ-SET-004: estimateCost scales linearly with token counts', () => {
    // 2,000 input tokens × $0.10/Mtok → $0.00020
    // 1,000 output tokens × $0.30/Mtok → $0.00030
    // total ≈ $0.00050
    const cost = estimateCost(DEFAULT_MODEL_ID, 2_000, 1_000);
    expect(cost).toBeCloseTo(0.00050, 9);
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
