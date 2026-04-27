// Implements REQ-PIPE-003
//
// Single LLM-call entrypoint with primary-then-fallback retry, used
// by every Workers-AI site that expects a JSON response. Replaces
// three near-identical try/parse/track-waste/retry blocks in
// scrape-chunk-consumer.ts, scrape-finalize-consumer.ts, and
// (eventually) discovery.ts (CF-009).
//
// Why a helper, not three copies:
//   - Token-cost accounting was subtly different at each site (only
//     the chunk consumer tracked wasted cost on primary failure;
//     discovery dropped the cost entirely). Centralising fixes that
//     by construction.
//   - The primary-vs-fallback decision is cross-cutting: if a future
//     change adds a third tier or a different fallback model, every
//     site needs to update in lock-step. One implementation, one
//     change.
//   - Tests only need to pin the contract here, not at every site.
//
// Behavior:
//   1. Run the primary model. If `narrow` returns a non-null T, return
//      `{ ok: true, fallbackUsed: false }` with token counts.
//   2. Else accumulate waste counters from the primary attempt and run
//      the fallback model. If `narrow` succeeds, return
//      `{ ok: true, fallbackUsed: true }` with both attempts' costs
//      separated (live = fallback's tokens; wasted = primary's).
//   3. If the fallback also fails, return `{ ok: false }` with both
//      attempts' raw responses so the caller can write a site-specific
//      diagnostic log line.

import { DEFAULT_MODEL_ID, FALLBACK_MODEL_ID, estimateCost } from '~/lib/models';
import {
  extractResponsePayload,
  extractTokensIn,
  extractTokensOut,
} from '~/lib/generate';

/** Minimal Workers-AI binding shape. We intentionally do not import
 *  the platform-typed `Ai` here so this helper is trivial to mock. */
interface AiBinding {
  run: (model: string, params: Record<string, unknown>) => Promise<unknown>;
}

interface AttemptInfo {
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
      fallbackUsed: boolean;
      wastedTokensIn: number;
      wastedTokensOut: number;
      wastedCostUsd: number;
      rawResponse: unknown;
    }
  | {
      ok: false;
      primary: AttemptInfo;
      fallback: AttemptInfo;
      wastedTokensIn: number;
      wastedTokensOut: number;
      wastedCostUsd: number;
    };

export interface RunJsonOptions<T> {
  ai: AiBinding;
  params: Record<string, unknown>;
  /** Caller-supplied parser. Returns the narrowed payload or null. */
  narrow: (rawResponse: unknown) => T | null;
  /** Optional override; defaults to DEFAULT_MODEL_ID. */
  primaryModel?: string;
  /** Optional override; defaults to FALLBACK_MODEL_ID. */
  fallbackModel?: string;
  /** Optional hook invoked with primary-call waste counters before the
   *  fallback runs. Useful when the call site wants to log a "trying
   *  fallback" breadcrumb with a custom event name. */
  onPrimaryFailure?: (info: AttemptInfo) => void;
}

export async function runJsonWithFallback<T>(
  options: RunJsonOptions<T>,
): Promise<LlmRunResult<T>> {
  const primaryModel = options.primaryModel ?? DEFAULT_MODEL_ID;
  const fallbackModel = options.fallbackModel ?? FALLBACK_MODEL_ID;

  const primaryResult = await options.ai.run(primaryModel, options.params);
  const primaryRaw = extractResponsePayload(primaryResult);
  const primaryParsed = options.narrow(primaryRaw);
  const primaryTokensIn = extractTokensIn(primaryResult);
  const primaryTokensOut = extractTokensOut(primaryResult);
  const primaryCostUsd = estimateCost(primaryModel, primaryTokensIn, primaryTokensOut);

  if (primaryParsed !== null) {
    return {
      ok: true,
      parsed: primaryParsed,
      modelUsed: primaryModel,
      tokensIn: primaryTokensIn,
      tokensOut: primaryTokensOut,
      costUsd: primaryCostUsd,
      fallbackUsed: false,
      wastedTokensIn: 0,
      wastedTokensOut: 0,
      wastedCostUsd: 0,
      rawResponse: primaryRaw,
    };
  }

  const primaryAttempt: AttemptInfo = {
    modelUsed: primaryModel,
    tokensIn: primaryTokensIn,
    tokensOut: primaryTokensOut,
    costUsd: primaryCostUsd,
    rawResponse: primaryRaw,
  };
  options.onPrimaryFailure?.(primaryAttempt);

  const fallbackResult = await options.ai.run(fallbackModel, options.params);
  const fallbackRaw = extractResponsePayload(fallbackResult);
  const fallbackParsed = options.narrow(fallbackRaw);
  const fallbackTokensIn = extractTokensIn(fallbackResult);
  const fallbackTokensOut = extractTokensOut(fallbackResult);
  const fallbackCostUsd = estimateCost(
    fallbackModel,
    fallbackTokensIn,
    fallbackTokensOut,
  );

  if (fallbackParsed !== null) {
    return {
      ok: true,
      parsed: fallbackParsed,
      modelUsed: fallbackModel,
      tokensIn: fallbackTokensIn,
      tokensOut: fallbackTokensOut,
      costUsd: fallbackCostUsd,
      fallbackUsed: true,
      wastedTokensIn: primaryTokensIn,
      wastedTokensOut: primaryTokensOut,
      wastedCostUsd: primaryCostUsd,
      rawResponse: fallbackRaw,
    };
  }

  return {
    ok: false,
    primary: primaryAttempt,
    fallback: {
      modelUsed: fallbackModel,
      tokensIn: fallbackTokensIn,
      tokensOut: fallbackTokensOut,
      costUsd: fallbackCostUsd,
      rawResponse: fallbackRaw,
    },
    wastedTokensIn: primaryTokensIn,
    wastedTokensOut: primaryTokensOut,
    wastedCostUsd: primaryCostUsd,
  };
}

/** Truncate a raw LLM response for log emission so a 50KB JSON dump
 *  doesn't blow past Cloudflare's structured-log size budget. */
export function previewRawResponse(raw: unknown, max = 400): string {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return s.slice(0, max);
}
