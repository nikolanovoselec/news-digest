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

  it('REQ-SET-004: MODELS contains exactly 4 featured and 6 budget entries', () => {
    const featured = MODELS.filter((m) => m.category === 'featured');
    const budget = MODELS.filter((m) => m.category === 'budget');
    expect(featured).toHaveLength(4);
    expect(budget).toHaveLength(6);
  });

  it('REQ-SET-004: MODELS ids are unique', () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('DEFAULT_MODEL_ID', () => {
  it('REQ-SET-004: DEFAULT_MODEL_ID is the fast Llama 3.1 8B fp8 variant', () => {
    expect(DEFAULT_MODEL_ID).toBe('@cf/meta/llama-3.1-8b-instruct-fp8-fast');
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
    // Llama 3.1 8B Fast: input 0.045 / output 0.384 per Mtok.
    // 1,000,000 input tokens → $0.045; 1,000,000 output tokens → $0.384 → total $0.429.
    const cost = estimateCost(DEFAULT_MODEL_ID, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.429, 6);
  });

  it('REQ-SET-004: estimateCost scales linearly with token counts', () => {
    // 2,000 input tokens at $0.045/Mtok → $0.00009
    // 1,000 output tokens at $0.384/Mtok → $0.000384
    // total ≈ $0.000474
    const cost = estimateCost(DEFAULT_MODEL_ID, 2_000, 1_000);
    expect(cost).toBeCloseTo(0.000474, 9);
  });

  it('REQ-SET-004: estimateCost returns 0 for Kimi models (prices unknown)', () => {
    const cost = estimateCost('@cf/moonshotai/kimi-k2.6', 1_000_000, 1_000_000);
    expect(cost).toBe(0);
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
