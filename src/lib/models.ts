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

// Default model: OpenAI gpt-oss-120b — 128K context, sync-capable,
// native JSON-mode support via response_format. Cost ~$0.006 per digest
// at 8K in / 12K out.
//
// Why not llama-3.3-70b-instruct-fp8-fast? The 70B "fast" variant only
// exposes a 24K context window (not 128K as its underlying model
// suggests) and is an async-queue-only endpoint; synchronous ai.run()
// calls returned an unhandled error. Switching to gpt-oss-120b gives us
// a genuinely large context window, sync inference, and stronger
// adherence to the JSON output contract.
export const DEFAULT_MODEL_ID = '@cf/openai/gpt-oss-120b';

export const MODELS: ModelOption[] = [
  // Featured — the four headline choices users see at the top of the dropdown.
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'GPT OSS 120B',
    description: 'Default. Native JSON mode, 128K context, reliable.',
    inputPricePerMtok: 0.35,
    outputPricePerMtok: 0.35,
    category: 'featured',
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    name: 'GPT OSS 20B',
    description: 'Cheaper OpenAI model, native JSON mode, 128K context.',
    inputPricePerMtok: 0.20,
    outputPricePerMtok: 0.35,
    category: 'featured',
  },
  {
    id: '@cf/moonshotai/kimi-k2.6',
    name: 'Kimi K2.6',
    description: 'Frontier-scale MoE (1T params, 32B active) from Moonshot AI',
    inputPricePerMtok: 0.16,
    outputPricePerMtok: 0.56,
    category: 'featured',
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    name: 'Llama 3.1 8B Fast',
    description: 'Budget Meta model, good quality at low cost.',
    inputPricePerMtok: 0.045,
    outputPricePerMtok: 0.384,
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
