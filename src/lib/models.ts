// Implements REQ-SET-004
//
// Hardcoded Workers AI model catalog. The list is the source of truth —
// server-side validation (`model_id` must appear in `MODELS`) keys off it,
// the settings dropdown is rendered from it, and per-digest cost is computed
// from its per-million-token prices. Updating the catalog is a code edit +
// deploy; there is no runtime fetch, no KV cache, no Cloudflare API token
// path. See /sdd/settings.md REQ-SET-004 and requirements.md "Model selection".

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  /** USD per million input tokens. */
  inputPricePerMtok: number;
  /** USD per million output tokens. */
  outputPricePerMtok: number;
  category: 'featured' | 'budget';
}

// Default model: @cf/openai/gpt-oss-20b. Native OpenAI JSON mode
// (response_format: json_object is HARD-guaranteed, not aspirational),
// 128K context, $0.20/$0.30 per M tokens. Swapped in as default after
// the Gemma-4 experiment failed — Gemma-4 is a REASONING model that
// emits chain-of-thought into choices[0].message.reasoning and only
// writes the final JSON to .content AFTER reasoning completes. With a
// 100-article chunk at 200-250 words each, Gemma's chain-of-thought
// ate the entire 50K max_tokens budget before producing any JSON, so
// every call landed with finish_reason=length + content=null, which
// extractResponsePayload correctly treats as malformed → fallback →
// (if fallback also failed, which it did) chunk dead-lettered.
//
// gpt-oss-20b is proven, the format is deterministic, and the price
// delta vs Gemma ($0.30/M out → same) is zero. The original fallback
// path (retry with gpt-oss-20b) is redundant when gpt-oss-20b IS the
// primary, so we promote gpt-oss-120b to fallback — more capable
// model in case 20B chokes on a weird candidate.
export const DEFAULT_MODEL_ID = '@cf/openai/gpt-oss-20b';

/** Fallback model the chunk consumer retries with on malformed-JSON
 * output. `@cf/openai/gpt-oss-120b` is the larger sibling of the
 * default — same OpenAI JSON contract but more parameters, so when
 * 20B trips on a pathological chunk the 120B pass is the safety net. */
export const FALLBACK_MODEL_ID = '@cf/openai/gpt-oss-120b';

export const MODELS: ModelOption[] = [
  // Featured — the four headline choices users see at the top of the dropdown.
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    name: 'Gemma 4 26B',
    description:
      'Default. 256K context, reasoning, Google-instruction-tuned, cheapest output.',
    inputPricePerMtok: 0.10,
    outputPricePerMtok: 0.30,
    category: 'featured',
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    name: 'GPT OSS 20B',
    description:
      'Failover. Native JSON mode, 128K context — the chunk consumer retries here on malformed-JSON output.',
    inputPricePerMtok: 0.20,
    outputPricePerMtok: 0.30,
    category: 'featured',
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'GPT OSS 120B',
    description: 'OpenAI 120B MoE. Native JSON mode, 128K context.',
    inputPricePerMtok: 0.35,
    outputPricePerMtok: 0.75,
    category: 'featured',
  },
  {
    id: '@cf/moonshotai/kimi-k2.5',
    name: 'Kimi K2.5',
    description:
      'Frontier MoE from Moonshot AI. 256K context, vision, reasoning.',
    inputPricePerMtok: 0.60,
    outputPricePerMtok: 3.00,
    category: 'featured',
  },

  // Budget — smaller or more-specialised options users can pick under "Advanced".
  {
    id: '@cf/meta/llama-3.2-1b-instruct',
    name: 'Llama 3.2 1B',
    description: 'Cheapest option. Short summaries only.',
    inputPricePerMtok: 0.027,
    outputPricePerMtok: 0.201,
    category: 'budget',
  },
  {
    id: '@cf/mistral/mistral-7b-instruct-v0.1',
    name: 'Mistral 7B',
    description: 'Balanced small model',
    inputPricePerMtok: 0.11,
    outputPricePerMtok: 0.19,
    category: 'budget',
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    name: 'Llama 3.2 3B',
    description: 'Small Meta model',
    inputPricePerMtok: 0.051,
    outputPricePerMtok: 0.335,
    category: 'budget',
  },
  {
    id: '@cf/meta/llama-3.2-11b-vision-instruct',
    name: 'Llama 3.2 11B',
    description: 'Mid-size Meta model, 128K context.',
    inputPricePerMtok: 0.049,
    outputPricePerMtok: 0.676,
    category: 'budget',
  },
  {
    id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    name: 'Mistral Small 3.1 24B',
    description: 'Mistral mid-size, 128K context.',
    inputPricePerMtok: 0.35,
    outputPricePerMtok: 0.56,
    category: 'budget',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek R1 32B',
    description: 'Reasoning-distilled model',
    inputPricePerMtok: 0.497,
    outputPricePerMtok: 4.881,
    category: 'budget',
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    name: 'Llama 3.1 8B Fast',
    description: 'Budget Meta model (8K context). Kept for legacy settings.',
    inputPricePerMtok: 0.045,
    outputPricePerMtok: 0.384,
    category: 'budget',
  },
];

/**
 * Look up a model by id. Returns `undefined` for unknown ids so callers can
 * distinguish "no model" from "invalid model" without throwing.
 */
export function modelById(id: string): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * Compute the USD cost of a single LLM call given the model's per-million-
 * token prices. Returns 0 for unknown models and for models whose prices are
 * not yet published (e.g. Kimi K2.x — both fields set to 0).
 */
export function estimateCost(modelId: string, tokensIn: number, tokensOut: number): number {
  const model = modelById(modelId);
  if (!model) return 0;
  const inputCost = (tokensIn / 1_000_000) * model.inputPricePerMtok;
  const outputCost = (tokensOut / 1_000_000) * model.outputPricePerMtok;
  return inputCost + outputCost;
}
