import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BILLED_REFUSAL_CATEGORIES,
  type CostInput,
  computeCost,
  formatCost,
  LOCAL_PRICE,
  type ModelPrice,
  pricingRule,
} from "./cost.ts";

const PER_M = 1_000_000;
const price: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const rules = pricingRule("anthropic");
const base = (over: Partial<CostInput> & Pick<CostInput, "usage">): CostInput => ({
  protocol: "anthropic-messages",
  model: "example-large",
  rates: () => ({ price, rule: rules }),
  ...over,
});

describe("rules file", () => {
  test("pins the spec numbers: 1.25x and 2x cache writes, x1.1 residency, $10 per 1,000 searches", () => {
    // spec: AC-RCPT-09
    expect(pricingRule("anthropic")).toEqual({
      cacheWrite5mMultiplier: 1.25,
      cacheWrite1hMultiplier: 2,
      residencyMultiplier: 1.1,
      serverToolUsd: { web_search: 0.01 },
    });
    expect(pricingRule("anthropic-legacy")?.residencyMultiplier).toBeUndefined();
    expect([...BILLED_REFUSAL_CATEGORIES].sort()).toEqual(["bio", "frontier_llm", "reasoning_extraction"]);
  });
});

describe("per-provider formulas against hand-computed values", () => {
  test("anthropic: 5m and 1h cache writes, cache read, input and output", () => {
    // spec: AC-RCPT-07
    const cost = computeCost(
      base({
        usage: {
          input_tokens: 1000,
          output_tokens: 2000,
          cache_creation_input_tokens: 10_000,
          cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 6000 },
          cache_read_input_tokens: 50_000,
        },
      }),
    );
    // 1000x3 + 4000x3.75 + 6000x(3x2) + 50000x0.3 + 2000x15
    expect(cost.usd).toBeCloseTo((3000 + 15_000 + 36_000 + 15_000 + 30_000) / PER_M, 10);
    expect(cost.approximate).toBe(false);
    expect(cost.tokens).toEqual({ input: 1000, cacheRead: 50_000, cacheWrite: 10_000, output: 2000 });
  });

  test("anthropic: creation tokens without the 5m/1h split are all 5m; a catalog without a write price uses 1.25x input", () => {
    // spec: AC-RCPT-07
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 8000 };
    expect(computeCost(base({ usage })).usd).toBeCloseTo((8000 * 3.75) / PER_M, 10);
    const noWrite = base({ usage, rates: () => ({ price: { input: 3, output: 15 }, rule: rules }) });
    expect(computeCost(noWrite).usd).toBeCloseTo((8000 * 3 * 1.25) / PER_M, 10);
  });

  test("openai-responses: cached tokens at the cache price, reasoning inside output", () => {
    // spec: AC-RCPT-07
    const usage = {
      input_tokens: 10_000,
      input_tokens_details: { cached_tokens: 4000 },
      output_tokens: 500,
      output_tokens_details: { reasoning_tokens: 200 },
    };
    const p: ModelPrice = { input: 2, output: 8, cacheRead: 0.5 };
    const cost = computeCost({ protocol: "openai-responses", model: "example-r", usage, rates: () => ({ price: p }) });
    expect(cost.usd).toBeCloseTo((6000 * 2 + 4000 * 0.5 + 500 * 8) / PER_M, 10);
    const withReasoning = computeCost({
      protocol: "openai-responses",
      model: "example-r",
      usage,
      rates: () => ({ price: { ...p, reasoning: 10 } }),
    });
    expect(withReasoning.usd).toBeCloseTo((6000 * 2 + 4000 * 0.5 + 300 * 8 + 200 * 10) / PER_M, 10);
  });

  test("google-interactions: thought tokens are output", () => {
    // spec: AC-RCPT-07
    const cost = computeCost({
      protocol: "google-interactions",
      model: "example-g",
      usage: {
        total_input_tokens: 8000,
        total_cached_tokens: 3000,
        total_output_tokens: 400,
        total_thought_tokens: 600,
      },
      rates: () => ({ price: { input: 1.25, output: 10, cacheRead: 0.31 } }),
    });
    expect(cost.usd).toBeCloseTo((5000 * 1.25 + 3000 * 0.31 + 1000 * 10) / PER_M, 10);
  });

  test("openai-compatible: the cached count comes from the record's usage path (DeepSeek) or the standard detail (Qwen)", () => {
    // spec: AC-RCPT-07
    const p: ModelPrice = { input: 0.28, output: 0.42, cacheRead: 0.028 };
    const deepseek = computeCost({
      protocol: "openai-chat",
      model: "example-d",
      usage: {
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
        completion_tokens: 100,
      },
      usageFields: { cachedInput: "prompt_cache_hit_tokens" },
      rates: () => ({ price: p }),
    });
    expect(deepseek.usd).toBeCloseTo((200 * 0.28 + 800 * 0.028 + 100 * 0.42) / PER_M, 12);
    const viaMiss = computeCost({
      protocol: "openai-chat",
      model: "example-d",
      usage: { prompt_tokens: 1000, prompt_cache_miss_tokens: 200, completion_tokens: 100 },
      usageFields: { cacheMiss: "prompt_cache_miss_tokens" },
      rates: () => ({ price: p }),
    });
    expect(viaMiss.usd).toBeCloseTo(deepseek.usd ?? Number.NaN, 12);
    const qwen = computeCost({
      protocol: "openai-chat",
      model: "example-q",
      usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: 100 },
      rates: () => ({ price: p }),
    });
    expect(qwen.usd).toBeCloseTo(deepseek.usd ?? Number.NaN, 12);
  });

  test("a recorded NVIDIA response is costed from its own usage object", () => {
    // spec: AC-RCPT-07
    const fixture = JSON.parse(
      readFileSync(new URL("../../test/fixtures/nvidia/text.json", import.meta.url), "utf8"),
    ) as {
      exchanges: { response: { body: string } }[];
    };
    const frames = (fixture.exchanges[0]?.response.body ?? "")
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)) as { usage?: Record<string, unknown> });
    const usage = frames.find((f) => f.usage !== undefined && f.usage !== null)?.usage;
    expect(usage?.prompt_tokens).toBe(237);
    expect(usage?.completion_tokens).toBe(3);
    const cost = computeCost({
      protocol: "openai-chat",
      model: "z-ai/glm-5.3-flash",
      usage: usage ?? {},
      rates: () => ({ price: { input: 1, output: 2 } }),
    });
    expect(cost.usd).toBeCloseTo((237 * 1 + 3 * 2) / PER_M, 12);
  });

  test("the SDK-normalized usage shape is read when the provider's own fields are absent", () => {
    // spec: AC-RCPT-07
    const cost = computeCost({
      protocol: "openai-chat",
      model: "example-n",
      usage: { inputTokens: { total: 1000, noCache: 700, cacheRead: 300 }, outputTokens: { total: 50, reasoning: 20 } },
      rates: () => ({ price: { input: 2, output: 4, cacheRead: 0.2 } }),
    });
    expect(cost.usd).toBeCloseTo((700 * 2 + 300 * 0.2 + 50 * 4) / PER_M, 12);
  });
});

describe("unknown, plan-billed and local prices", () => {
  test("an unknown price is `?`, never $0.00", () => {
    // spec: AC-RCPT-06
    const cost = computeCost(base({ usage: { input_tokens: 10, output_tokens: 10 }, rates: () => ({ price: null }) }));
    expect(cost.usd).toBeNull();
    expect(cost.planBilled).toBe(false);
    expect(formatCost(cost)).toBe("?");
  });

  test("usage with no token counts is unknown, not free", () => {
    // spec: AC-RCPT-06
    for (const usage of [
      {},
      { unrelated: 1 },
      { input_tokens: "12", output_tokens: 1 },
      { input_tokens: -5, output_tokens: 1 },
    ]) {
      const cost = computeCost(base({ usage }));
      expect(cost.usd).toBeNull();
      expect(formatCost(cost)).toBe("?");
    }
  });

  test("a missing cache-read price falls back to the input price and is marked approximate", () => {
    // spec: AC-RCPT-06
    const cost = computeCost(
      base({
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000 },
        rates: () => ({ price: { input: 3, output: 15 }, rule: rules }),
      }),
    );
    expect(cost.usd).toBeCloseTo((1000 * 3) / PER_M, 12);
    expect(cost.approximate).toBe(true);
    expect(formatCost(cost)).toBe("≈$0.0030");
  });

  test("a missing price that no token uses changes nothing", () => {
    // spec: AC-RCPT-06
    const cost = computeCost(
      base({
        usage: { input_tokens: 1000, output_tokens: 0 },
        rates: () => ({ price: { input: 3, output: 15 }, rule: rules }),
      }),
    );
    expect(cost.approximate).toBe(false);
  });

  test("a plan-billed endpoint has tokens and no dollars", () => {
    // spec: AC-RCPT-06
    const cost = computeCost(base({ usage: { input_tokens: 100, output_tokens: 20 }, billing: "plan" }));
    expect(cost).toMatchObject({ usd: null, approximate: false, planBilled: true });
    expect(cost.tokens).toEqual({ input: 100, cacheRead: 0, cacheWrite: 0, output: 20 });
    expect(formatCost(cost)).toBe("billed to plan allowance");
  });

  test("a local model costs a true $0.00", () => {
    // spec: AC-RCPT-06
    const cost = computeCost(
      base({ usage: { input_tokens: 100, output_tokens: 20 }, rates: () => ({ price: LOCAL_PRICE }) }),
    );
    expect(cost).toMatchObject({ usd: 0, approximate: false });
    expect(formatCost(cost)).toBe("$0.00");
  });

  test("formatCost shows two decimals from one cent up and four below, and never rounds a cost to $0.00", () => {
    // spec: AC-RCPT-06
    const f = (usd: number) =>
      formatCost({
        usd,
        approximate: false,
        planBilled: false,
        models: [],
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      });
    expect(f(0.31)).toBe("$0.31");
    expect(f(2.14)).toBe("$2.14");
    expect(f(0.0004)).toBe("$0.0004");
    expect(f(0.00001)).toBe("<$0.0001");
  });
});

describe("server tool fees", () => {
  test("web searches are priced from the rules file and not multiplied by residency", () => {
    // spec: AC-RCPT-06
    const usage = { input_tokens: 1000, output_tokens: 0, server_tool_use: { web_search_requests: 3 } };
    const cost = computeCost(base({ usage, inferenceGeo: "us" }));
    expect(cost.usd).toBeCloseTo((1000 * 3 * 1.1) / PER_M + 0.03, 10);
  });

  test("a server tool with no known fee is approximate", () => {
    // spec: AC-RCPT-06
    const usage = { input_tokens: 1000, output_tokens: 0, server_tool_use: { code_execution_requests: 2 } };
    const cost = computeCost(base({ usage }));
    expect(cost.usd).toBeCloseTo((1000 * 3) / PER_M, 12);
    expect(cost.approximate).toBe(true);
  });
});

describe("iterations", () => {
  const small: ModelPrice = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  const usage = {
    input_tokens: 9999,
    output_tokens: 9999,
    iterations: [
      { type: "message", model: "example-large", input_tokens: 1000, output_tokens: 500 },
      {
        type: "fallback_message",
        model: "example-small",
        input_tokens: 2000,
        output_tokens: 300,
        cache_read_input_tokens: 4000,
      },
    ],
  };
  const rates = (m: string) => ({ price: m === "example-small" ? small : price, rule: rules });

  test("each iteration is priced at its own model's rates and both models are named", () => {
    // spec: AC-RCPT-08
    const cost = computeCost(base({ usage, model: "example-small", rates }));
    const large = 1000 * 3 + 500 * 15;
    const fallback = 2000 * 1 + 300 * 5 + 4000 * 0.1;
    expect(cost.usd).toBeCloseTo((large + fallback) / PER_M, 10);
    expect(cost.models).toEqual(["example-small", "example-large"]);
    expect(cost.tokens).toEqual({ input: 3000, cacheRead: 4000, cacheWrite: 0, output: 800 });
  });

  test("an iteration without a model is the answering model; an unpriced iteration makes the total unknown", () => {
    // spec: AC-RCPT-08
    const noModel = { iterations: [{ type: "message", input_tokens: 1000, output_tokens: 0 }] };
    expect(computeCost(base({ usage: noModel })).usd).toBeCloseTo((1000 * 3) / PER_M, 12);
    const unpriced = computeCost(
      base({
        usage,
        model: "example-small",
        rates: (m) => ({ price: m === "example-small" ? small : null, rule: rules }),
      }),
    );
    expect(unpriced.usd).toBeNull();
    expect(unpriced.models).toEqual(["example-small", "example-large"]);
  });
});

describe("refusals", () => {
  const usage = { input_tokens: 2000, output_tokens: 100 };
  const full = (2000 * 3 + 100 * 15) / PER_M;

  test("a pre-output refusal in a category Anthropic does not bill costs $0 and keeps the category", () => {
    // spec: AC-RCPT-08
    const cost = computeCost(base({ usage, refusal: { category: "cyber", beforeOutput: true } }));
    expect(cost.usd).toBe(0);
    expect(cost.refusalCategory).toBe("cyber");
    expect(formatCost(cost)).toBe("$0.00");
  });

  test("a pre-output refusal in a billed category is billed in full", () => {
    // spec: AC-RCPT-08
    for (const category of ["bio", "frontier_llm", "reasoning_extraction"]) {
      const cost = computeCost(base({ usage, refusal: { category, beforeOutput: true } }));
      expect(cost.usd).toBeCloseTo(full, 12);
      expect(cost.refusalCategory).toBe(category);
    }
  });

  test("a mid-stream refusal bills the input and the output already streamed, whatever the category", () => {
    // spec: AC-RCPT-08
    const cost = computeCost(base({ usage, refusal: { category: "cyber", beforeOutput: false } }));
    expect(cost.usd).toBeCloseTo(full, 12);
    expect(cost.refusalCategory).toBe("cyber");
  });

  test("the unbilled-category rule is Anthropic's: another protocol bills what its usage says", () => {
    // spec: AC-RCPT-08
    const cost = computeCost({
      protocol: "openai-chat",
      model: "example-c",
      usage: { prompt_tokens: 1000, completion_tokens: 0 },
      rates: () => ({ price: { input: 2, output: 4 } }),
      refusal: { category: "content_filter", beforeOutput: true },
    });
    expect(cost.usd).toBeCloseTo((1000 * 2) / PER_M, 12);
    expect(cost.refusalCategory).toBe("content_filter");
  });
});

describe("data residency, endpoint surcharges and long-context tiers", () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 2000,
    cache_creation_input_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 3000 },
    cache_read_input_tokens: 10_000,
  };
  const plain = (computeCost(base({ usage })).usd ?? Number.NaN) as number;

  test("inferenceGeo us multiplies every price category by 1.1 on a 4.6+ model, and nothing without it", () => {
    // spec: AC-RCPT-09
    expect(computeCost(base({ usage, inferenceGeo: "us" })).usd).toBeCloseTo(plain * 1.1, 12);
    expect(computeCost(base({ usage })).usd).toBeCloseTo(plain, 12);
    const legacy = base({ usage, inferenceGeo: "us", rates: () => ({ price, rule: pricingRule("anthropic-legacy") }) });
    expect(computeCost(legacy).usd).toBeCloseTo(plain, 12);
  });

  test("a regional Bedrock endpoint costs its own prices plus the record's 10%", () => {
    // spec: AC-RCPT-09
    const bedrock: ModelPrice = { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 };
    const cost = computeCost(base({ usage, rates: () => ({ price: bedrock, rule: rules }), endpointMultiplier: 1.1 }));
    const own = 1000 * 3.3 + 1000 * 4.125 + 3000 * 3.3 * 2 + 10_000 * 0.33 + 2000 * 16.5;
    expect(cost.usd).toBeCloseTo((own * 1.1) / PER_M, 10);
  });

  const haiku: ModelPrice = {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    tiers: [{ size: 100_000, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  };
  const haikuRates = () => ({ price: haiku, rule: rules });

  test("a prompt over 100,000 tokens is priced entirely at the higher rates", () => {
    // spec: AC-RCPT-09
    const cost = computeCost(
      base({
        usage: {
          input_tokens: 20_000,
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: 10_000,
          output_tokens: 1000,
        },
        rates: haikuRates,
      }),
    );
    // prompt = 20k + 90k + 10k = 120k
    expect(cost.usd).toBeCloseTo((20_000 * 2 + 90_000 * 0.2 + 10_000 * 2.5 + 1000 * 10) / PER_M, 10);
  });

  test("exactly 100,000 tokens stays at the base rates", () => {
    // spec: AC-RCPT-09
    const cost = computeCost(base({ usage: { input_tokens: 100_000, output_tokens: 0 }, rates: haikuRates }));
    expect(cost.usd).toBeCloseTo((100_000 * 1) / PER_M, 10);
  });

  test("the largest matching tier wins; a tier without a cache price falls back to input and is approximate", () => {
    // spec: AC-RCPT-09
    const p: ModelPrice = {
      input: 1,
      output: 2,
      cacheRead: 0.1,
      tiers: [
        { size: 200_000, input: 4, output: 8 },
        { size: 100_000, input: 2, output: 4, cacheRead: 0.2 },
      ],
    };
    const rates = () => ({ price: p });
    const mid = computeCost({
      protocol: "openai-responses",
      model: "m",
      usage: { input_tokens: 150_000, output_tokens: 10 },
      rates,
    });
    expect(mid.usd).toBeCloseTo((150_000 * 2 + 10 * 4) / PER_M, 10);
    const top = computeCost({
      protocol: "openai-responses",
      model: "m",
      usage: { input_tokens: 250_000, input_tokens_details: { cached_tokens: 50_000 }, output_tokens: 10 },
      rates,
    });
    expect(top.usd).toBeCloseTo((200_000 * 4 + 50_000 * 4 + 10 * 8) / PER_M, 10);
    expect(top.approximate).toBe(true);
  });
});

describe("unusual usage values", () => {
  test("null detail fields, huge counts and a refusal with no output do not break the sum", () => {
    // spec: AC-RCPT-07
    const cost = computeCost({
      protocol: "openai-chat",
      model: "example-n",
      usage: {
        prompt_tokens: 1e12,
        prompt_tokens_details: { audio_tokens: null, cached_tokens: null },
        completion_tokens: 0,
        completion_tokens_details: null,
      },
      rates: () => ({ price: { input: 1, output: 1 } }),
    });
    expect(cost.usd).toBeCloseTo(1e6, 3);
  });

  test("more cached tokens than input tokens is unknown rather than negative", () => {
    // spec: AC-RCPT-06
    const cost = computeCost({
      protocol: "openai-responses",
      model: "example-r",
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 50 }, output_tokens: 1 },
      rates: () => ({ price: { input: 1, output: 1, cacheRead: 0.1 } }),
    });
    expect(cost.usd).toBeNull();
  });
});
