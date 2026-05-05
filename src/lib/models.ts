// Implements REQ-SET-004
//
// Hardcoded Workers AI model catalog. The list is the source of truth —
// server-side validation (`model_id` must appear in `MODELS`) keys off it,
// the settings dropdown is rendered from it, and per-digest cost is computed
// from its per-million-token prices. Updating the catalog is a code edit +
// deploy; there is no runtime fetch, no KV cache, no Cloudflare API token
// path. See /sdd/settings.md REQ-SET-004 and REQUIREMENTS.md "Model selection".

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

// Default model: @cf/google/gemma-4-26b-a4b-it. 256K context (~2x
// gpt-oss-120b), $0.10/$0.30 per M tokens (~3.5x cheaper output).
// The bigger context lets the chunk packer carry full 15K-char
// long-form-essay snippets without splitting; the price drop pays
// for the cron-tick budget at scale. Earlier Gemma-class models
// were dropped because they undershot the 200-250 word target —
// Gemma 4 is a newer release; flipped on 2026-05-05 to test
// against the current 150-200 word contract on integration first
// before touching production.
//
// Fallback stays at @cf/openai/gpt-oss-120b — proven on the 150-200
// word band, used only when Gemma 4 fails JSON parsing.
export const DEFAULT_MODEL_ID = '@cf/google/gemma-4-26b-a4b-it';

/** Fallback model the chunk consumer retries with on malformed-JSON
 * output. `@cf/openai/gpt-oss-120b` is proven against the 150-200
 * word contract; Gemma 4 is the cheaper default but unproven on
 * verbosity, so 120B backstops the malformed-JSON retry path. */
export const FALLBACK_MODEL_ID = '@cf/openai/gpt-oss-120b';

export const MODELS: ModelOption[] = [
  // Featured — the four headline choices users see at the top of the dropdown.
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    name: 'Gemma 4 26B',
    description:
      'Default. 256K context, Google-instruction-tuned. Cheapest of the featured tier.',
    inputPricePerMtok: 0.10,
    outputPricePerMtok: 0.30,
    category: 'featured',
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    name: 'GPT OSS 20B',
    description:
      'Native JSON mode, 128K context. Cheaper sibling of 120B.',
    inputPricePerMtok: 0.20,
    outputPricePerMtok: 0.30,
    category: 'featured',
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'GPT OSS 120B',
    description: 'Failover. OpenAI 120B MoE with native JSON mode, 128K context — the chunk consumer retries here on malformed-JSON output.',
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
