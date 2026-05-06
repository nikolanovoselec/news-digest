// Implements REQ-PIPE-002
// Implements REQ-PIPE-008
//
// Single LLM-call entrypoint used by every Workers-AI site that expects
// a JSON response (chunk consumer, finalize consumer, discovery).
//
// Single-model architecture (2026-05-06): the helper runs ONE model
// per call. The previous primary-then-fallback path (Gemma → 120b)
// was removed when the project consolidated on a single model;
// swapping models means changing `DEFAULT_MODEL_ID` in `~/lib/models`,
// not threading two model ids through every call site.
//
// Why a helper, not three copies:
//   - Token-cost accounting was subtly different at each site (only
//     the chunk consumer tracked wasted cost on primary failure;
//     discovery dropped the cost entirely). Centralising fixes that
//     by construction.
//   - Tests only need to pin the contract here, not at every site.
//
// Behavior:
//   1. Run the model. If `narrow` returns a non-null T, return
//      `{ ok: true }` with the parsed payload and token counts.
//   2. If the call throws (AiError 3046 timeout, network errors,
//      capacity failures) OR `narrow` returns null, return
//      `{ ok: false }` with the raw response so the caller can write
//      a site-specific diagnostic log line.

import { DEFAULT_MODEL_ID, estimateCost } from '~/lib/models';
import {
  extractResponsePayload,
  extractTokensIn,
  extractTokensOut,
  type AIRunResponse,
} from '~/lib/generate';

/** Minimal Workers-AI binding shape. We intentionally do not import
 *  the platform-typed `Ai` here so this helper is trivial to mock. */
export interface AiBinding {
  run: (model: string, params: Record<string, unknown>) => Promise<unknown>;
}

/** Cast an unknown env binding to {@link AiBinding}. Centralizes the
 *  three identical `as unknown as { run: ... }` casts that were
 *  duplicated across queue consumers and discovery (CF-016). */
export function asAiBinding(ai: unknown): AiBinding {
  return ai as AiBinding;
}

export interface AttemptInfo {
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  rawResponse: unknown;
}

export type LlmRunResult<T> =
  | {
      ok: true;
      parsed: T;
      modelUsed: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      rawResponse: unknown;
    }
  | {
      ok: false;
      attempt: AttemptInfo;
    };

export interface RunJsonOptions<T> {
  ai: AiBinding;
  params: Record<string, unknown>;
  /** Caller-supplied parser. Returns the narrowed payload or null. */
  narrow: (rawResponse: unknown) => T | null;
  /** Optional override; defaults to DEFAULT_MODEL_ID. */
  model?: string;
}

export async function runJson<T>(
  options: RunJsonOptions<T>,
): Promise<LlmRunResult<T>> {
  const model = options.model ?? DEFAULT_MODEL_ID;

  // The Workers-AI binding's contract is `Promise<unknown>` because
  // every model emits a slightly different envelope. The shared
  // helpers in ~/lib/generate accept the wider AIRunResponse shape
  // (which has an index signature) and gracefully tolerate missing
  // fields, so a single cast at the boundary is safe.
  //
  // Throws (AiError 3046 timeout, network errors, capacity failures)
  // are caught and surfaced as `ok: false` so the caller can decide
  // whether to retry the queue message or surface a structured log.
  let result: AIRunResponse | null = null;
  let threwError: string | null = null;
  try {
    result = (await options.ai.run(model, options.params)) as AIRunResponse;
  } catch (err) {
    threwError = String(err).slice(0, 500);
  }
  const raw = result === null ? null : extractResponsePayload(result);
  const parsed = result === null ? null : options.narrow(raw);
  const tokensIn = result === null ? 0 : extractTokensIn(result);
  const tokensOut = result === null ? 0 : extractTokensOut(result);
  const costUsd = estimateCost(model, tokensIn, tokensOut);

  if (parsed !== null) {
    return {
      ok: true,
      parsed,
      modelUsed: model,
      tokensIn,
      tokensOut,
      costUsd,
      rawResponse: raw,
    };
  }

  return {
    ok: false,
    attempt: {
      modelUsed: model,
      tokensIn,
      tokensOut,
      costUsd,
      rawResponse: threwError !== null ? { error: threwError } : raw,
    },
  };
}

/** Truncate a raw LLM response for log emission so a 50KB JSON dump
 *  doesn't blow past Cloudflare's structured-log size budget. */
export function previewRawResponse(raw: unknown, max = 400): string {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return s.slice(0, max);
}
