import { describe, expect, test } from "bun:test";
import { CHARS_PER_TOKEN, estimateRequest, expectedOutput, MIN_EXPECTED_OUTPUT } from "./estimate.ts";

const RATES = { input: 3, output: 15, cacheRead: 0.3 };

// spec: AC-RCPT-03
describe("expected output", () => {
  test("is the median of the session's outputs, never below 2,000 tokens", () => {
    expect(expectedOutput([])).toBe(MIN_EXPECTED_OUTPUT);
    expect(expectedOutput([100, 300])).toBe(MIN_EXPECTED_OUTPUT);
    expect(expectedOutput([9000, 100, 5000])).toBe(5000);
    expect(expectedOutput([4000, 8000])).toBe(6000);
  });
});

// spec: AC-RCPT-03
describe("request estimate", () => {
  test("first request: all of its characters at 3.5 per token, uncached, plus the expected output", () => {
    const e = estimateRequest({ last: null, newChars: 7000, outputs: [], rates: RATES });
    expect(CHARS_PER_TOKEN).toBe(3.5);
    expect(e.inputTokens).toBe(2000);
    expect(e.cacheReadTokens).toBe(0);
    expect(e.outputTokens).toBe(2000);
    expect(e.usd).toBeCloseTo((2000 * 3 + 2000 * 15) / 1e6, 10);
  });

  test("later request: last actual input plus the new characters; cache reads priced at the cache price", () => {
    const last = { input: 1000, cacheRead: 9000, cacheWrite: 500, output: 700 };
    const e = estimateRequest({ last, newChars: 3500, outputs: [700], rates: RATES });
    expect(e.cacheReadTokens).toBe(9000);
    expect(e.inputTokens).toBe(1000 + 500 + 1000);
    expect(e.outputTokens).toBe(2000);
    expect(e.usd).toBeCloseTo((2500 * 3 + 9000 * 0.3 + 2000 * 15) / 1e6, 10);
  });

  test("a missing cache price is replaced by the input price", () => {
    const e = estimateRequest({
      last: { input: 0, cacheRead: 1000, cacheWrite: 0, output: 0 },
      newChars: 0,
      outputs: [],
      rates: { input: 3, output: 15 },
    });
    expect(e.usd).toBeCloseTo((1000 * 3 + 2000 * 15) / 1e6, 10);
  });

  test("characters are never negative and a huge prompt does not overflow", () => {
    expect(estimateRequest({ last: null, newChars: 0, outputs: [], rates: RATES }).inputTokens).toBe(0);
    const big = estimateRequest({ last: null, newChars: 10 ** 12, outputs: [], rates: RATES });
    expect(Number.isFinite(big.usd)).toBe(true);
  });
});
