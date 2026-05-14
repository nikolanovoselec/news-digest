// Implements REQ-SET-004
//
// Hardcoded Workers AI model catalog. The list is the source of truth —
// server-side validation (`model_id` must appear in `MODELS`) keys off it,
// the settings dropdown is rendered from it, and per-digest cost is computed
// from its per-million-token prices. Updating the catalog is a code edit +
// deploy; there is no runtime fetch, no KV cache, no Cloudflare API token
// path. See /sdd/settings.md REQ-SET-004 and REQUIREMENTS.md "Model selection".
//
// Single-model architecture (2026-05-06): the chunk/finalize/discovery
// pipelines run one model per call, no fallback. Swapping models means
// changing `DEFAULT_MODEL_ID` to a different entry; every other tuning
// constant (max_tokens, char budgets) stays put as long as the chosen
// model's `contextTokens` is large enough to absorb them. `contextTokens`
// is the single per-model knob — every other number in the pipeline
// stays identical across models.

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  /** USD per million input tokens. */
  inputPricePerMtok: number;
  /** USD per million output tokens. */
  outputPricePerMtok: number;
  /** Total context window size in tokens (input + output combined).
   *  Workers AI enforces `prompt_tokens + max_tokens <= contextTokens`
   *  per call. The chunk packer + LLM_PARAMS are tuned to fit inside
   *  the smallest reasonable context (~128K). Larger contexts simply
   *  leave more headroom. This is the single number that varies per
   *  model — every other tuning constant in the pipeline stays the
   *  same when swapping. */
  contextTokens: number;
  category: 'featured' | 'budget';
}

// Default model: @cf/openai/gpt-oss-120b. 128K context, native JSON
// mode, $0.35/$0.75 per Mtok. AD48 swapped this to gpt-oss-20b on
// 2026-05-14 to cut chunk-summarisation cost ~60%, but the first
// production run after the swap (pipeline_run 01KRJYV8R0D0EX7HBPR2VS2YCT)
// failed with scrape_wait_stalled — every scrape-chunks queue
// invocation produced outcome=canceled mid-LLM-call, the same wall-
// clock failure mode that took Gemma 4 26B out of contention on
// 2026-05. Reverted to gpt-oss-120b for chunk reliability; the
// AD48 watermark + batched rerank changes stay in place and carry
// most of the cost reduction on their own. See AD48 rollback note.
// This constant is the single source-of-truth for the pipeline's
// model id (chunk summarisation, rerank, discovery all flow through
// DEFAULT_MODEL_ID).
export const DEFAULT_MODEL_ID = '@cf/openai/gpt-oss-120b';

export const MODELS: ModelOption[] = [
  // Featured — the four headline choices users see at the top of the dropdown.
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'GPT OSS 120B',
    description:
      'Default. OpenAI 120B MoE with native JSON mode, 128K context. Reliable wall-clock for chunk-sized prompts.',
    inputPricePerMtok: 0.35,
    outputPricePerMtok: 0.75,
    contextTokens: 128_000,
    category: 'featured',
  },
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    name: 'Gemma 4 26B',
    description:
      'Google instruction-tuned, 256K context. Cheaper than 120B but timed out on chunk-sized prompts in 2026-05 production runs.',
    inputPricePerMtok: 0.10,
    outputPricePerMtok: 0.30,
    contextTokens: 256_000,
    category: 'featured',
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    name: 'GPT OSS 20B',
    description:
      'Native JSON mode, 128K context. Cheaper sibling of 120B at $0.20/$0.30 per Mtok, but mid-call cancels on chunk-sized prompts in production (AD48 rollback, 2026-05-14).',
    inputPricePerMtok: 0.20,
    outputPricePerMtok: 0.30,
    contextTokens: 128_000,
    category: 'featured',
  },
  {
    id: '@cf/moonshotai/kimi-k2.5',
    name: 'Kimi K2.5',
    description:
      'Frontier MoE from Moonshot AI. 256K context, vision, reasoning.',
    inputPricePerMtok: 0.60,
    outputPricePerMtok: 3.00,
    contextTokens: 256_000,
    category: 'featured',
  },

  // Budget — smaller or more-specialised options users can pick under "Advanced".
  {
    id: '@cf/meta/llama-3.2-1b-instruct',
    name: 'Llama 3.2 1B',
    description: 'Cheapest option. Short summaries only.',
    inputPricePerMtok: 0.027,
    outputPricePerMtok: 0.201,
    contextTokens: 128_000,
    category: 'budget',
  },
  {
    id: '@cf/mistral/mistral-7b-instruct-v0.1',
    name: 'Mistral 7B',
    description: 'Balanced small model',
    inputPricePerMtok: 0.11,
    outputPricePerMtok: 0.19,
    contextTokens: 32_768,
    category: 'budget',
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    name: 'Llama 3.2 3B',
    description: 'Small Meta model',
    inputPricePerMtok: 0.051,
    outputPricePerMtok: 0.335,
    contextTokens: 128_000,
    category: 'budget',
  },
  {
    id: '@cf/meta/llama-3.2-11b-vision-instruct',
    name: 'Llama 3.2 11B',
    description: 'Mid-size Meta model, 128K context.',
    inputPricePerMtok: 0.049,
    outputPricePerMtok: 0.676,
    contextTokens: 128_000,
    category: 'budget',
  },
  {
    id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    name: 'Mistral Small 3.1 24B',
    description: 'Mistral mid-size, 128K context.',
    inputPricePerMtok: 0.35,
    outputPricePerMtok: 0.56,
    contextTokens: 128_000,
    category: 'budget',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek R1 32B',
    description: 'Reasoning-distilled model',
    inputPricePerMtok: 0.497,
    outputPricePerMtok: 4.881,
    contextTokens: 80_000,
    category: 'budget',
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    name: 'Llama 3.1 8B Fast',
    description: 'Budget Meta model (8K context). Kept for legacy settings.',
    inputPricePerMtok: 0.045,
    outputPricePerMtok: 0.384,
    contextTokens: 8_192,
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
