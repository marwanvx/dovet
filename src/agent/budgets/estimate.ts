// Pre-flight cost of the next request (receipts-budgets "Behavior" 1): no count-tokens call, the last real usage plus new text.
import type { PriceRates, TokenTotals } from "../../ai/index.ts";

export const CHARS_PER_TOKEN = 3.5;
export const MIN_EXPECTED_OUTPUT = 2000;
/** USD per 1M tokens for a model with no catalog price yet (the live meter's rates until M4-02). */
export const PLACEHOLDER_RATES: PriceRates = { input: 2, output: 6 };

export type Estimate = { inputTokens: number; cacheReadTokens: number; outputTokens: number; usd: number };

export function expectedOutput(outputs: readonly number[]): number {
  if (outputs.length === 0) return MIN_EXPECTED_OUTPUT;
  const sorted = [...outputs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.max(MIN_EXPECTED_OUTPUT, median);
}

/**
 * `last` is the previous response's usage. Only what that response read from the cache is priced as a cache read; what it
 * wrote is priced as plain input, so a cold cache costs the estimate nothing extra (QUESTIONS Q83).
 */
export function estimateRequest(args: {
  last: TokenTotals | null;
  newChars: number;
  outputs: readonly number[];
  rates: PriceRates;
}): Estimate {
  const newTokens = Math.max(0, args.newChars) / CHARS_PER_TOKEN;
  const cacheReadTokens = args.last?.cacheRead ?? 0;
  const lastTotal = args.last === null ? 0 : args.last.input + args.last.cacheRead + args.last.cacheWrite;
  const inputTokens = lastTotal - cacheReadTokens + newTokens;
  const outputTokens = expectedOutput(args.outputs);
  const { rates } = args;
  const usd =
    (inputTokens * rates.input + cacheReadTokens * (rates.cacheRead ?? rates.input) + outputTokens * rates.output) /
    1e6;
  return { inputTokens, cacheReadTokens, outputTokens, usd };
}
