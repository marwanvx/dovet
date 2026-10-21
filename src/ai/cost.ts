// Cost of one model response from its raw usage, catalog prices and pricing rules (receipts-budgets "Cost computation").
import { z } from "zod";
import type { Protocol } from "../schema/index.ts";
import rulesFile from "./pricing-rules.jsonc";

const PER_M = 1_000_000;

export type PriceRates = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
/** USD per 1M tokens; `tiers` replace every rate when the prompt is larger than `size` (models.dev `cost.tiers`). */
export type ModelPrice = PriceRates & { reasoning?: number; tiers?: (PriceRates & { size: number })[] };

export const PricingRule = z.strictObject({
  cacheWrite5mMultiplier: z.number().positive().optional(),
  cacheWrite1hMultiplier: z.number().positive().optional(),
  residencyMultiplier: z.number().positive().optional(),
  serverToolUsd: z.record(z.string(), z.number().nonnegative()).optional(),
});
export type PricingRule = z.infer<typeof PricingRule>;

const RulesFile = z.strictObject({
  billedRefusalCategories: z.array(z.string()),
  rules: z.record(z.string(), PricingRule),
});
const parsedRules = RulesFile.parse(rulesFile);

export const BILLED_REFUSAL_CATEGORIES: ReadonlySet<string> = new Set(parsedRules.billedRefusalCategories);

export function pricingRule(key: string): PricingRule | undefined {
  return parsedRules.rules[key];
}

export const LOCAL_PRICE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type ModelRates = { price: ModelPrice | null; rule?: PricingRule | undefined };

export type CostInput = {
  protocol: Protocol;
  /** The model that answered. */
  model: string;
  usage: Record<string, unknown>;
  /** Price and rule of a model by id, for this provider only (prices are never looked up by model alone). */
  rates: (model: string) => ModelRates;
  billing?: "per-token" | "plan";
  /** JSON paths into `usage` (the provider record's `usageFields`). */
  usageFields?: { cachedInput?: string; cacheMiss?: string; reasoningOutput?: string };
  /** `providers.anthropic.inferenceGeo`, when set. */
  inferenceGeo?: string;
  /** The provider record's own surcharge, e.g. 1.1 for a regional Bedrock endpoint. */
  endpointMultiplier?: number;
  refusal?: { category: string; beforeOutput: boolean };
};

export type TokenTotals = { input: number; cacheRead: number; cacheWrite: number; output: number };

export type Cost = {
  /** null: unknown (`?`), or plan-billed. */
  usd: number | null;
  /** The sum leaves out or guesses a price (`≈`). */
  approximate: boolean;
  planBilled: boolean;
  /** The answering model first, then every other model that ran. */
  models: string[];
  tokens: TokenTotals;
  refusalCategory?: string;
};

type Call = {
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
};

const Count = z.number().finite().nonnegative().nullish();

const AnthropicCall = z.looseObject({
  type: z.string().optional(),
  model: z.string().optional(),
  input_tokens: Count,
  output_tokens: Count,
  cache_creation_input_tokens: Count,
  cache_read_input_tokens: Count,
  cache_creation: z.looseObject({ ephemeral_5m_input_tokens: Count, ephemeral_1h_input_tokens: Count }).nullish(),
});
const AnthropicUsage = AnthropicCall.extend({
  iterations: z.array(AnthropicCall).nullish(),
  server_tool_use: z.record(z.string(), z.unknown()).nullish(),
});
const ResponsesUsage = z.looseObject({
  input_tokens: Count,
  output_tokens: Count,
  input_tokens_details: z.looseObject({ cached_tokens: Count }).nullish(),
  output_tokens_details: z.looseObject({ reasoning_tokens: Count }).nullish(),
});
const GoogleUsage = z.looseObject({
  total_input_tokens: Count,
  total_cached_tokens: Count,
  total_output_tokens: Count,
  total_thought_tokens: Count,
});
const ChatUsage = z.looseObject({
  prompt_tokens: Count,
  completion_tokens: Count,
  prompt_tokens_details: z.looseObject({ cached_tokens: Count }).nullish(),
  completion_tokens_details: z.looseObject({ reasoning_tokens: Count }).nullish(),
});
const SdkUsage = z.looseObject({
  inputTokens: z.looseObject({ total: Count, noCache: Count, cacheRead: Count, cacheWrite: Count }),
  outputTokens: z.looseObject({ total: Count, reasoning: Count }),
});

const n = (v: number | null | undefined): number => v ?? 0;

function pathCount(usage: Record<string, unknown>, path: string | undefined): number | undefined {
  if (path === undefined) return undefined;
  let cur: unknown = usage;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  const parsed = Count.safeParse(cur);
  return parsed.success && parsed.data !== null && parsed.data !== undefined ? parsed.data : undefined;
}

/** Splits a prompt of `total` tokens, `cached` of them cache reads; null when the counts cannot be right. */
function splitPrompt(model: string, total: number, cached: number, output: number, reasoning: number): Call | null {
  if (cached < 0 || cached > total || reasoning > output) return null;
  return { model, input: total - cached, cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0, output, reasoning };
}

function anthropicCall(model: string, c: z.infer<typeof AnthropicCall>): Call | null {
  if (c.input_tokens === undefined && c.output_tokens === undefined) return null;
  const w5 = n(c.cache_creation?.ephemeral_5m_input_tokens);
  const w1 = n(c.cache_creation?.ephemeral_1h_input_tokens);
  const written = c.cache_creation_input_tokens ?? w5 + w1;
  if (w5 + w1 > written) return null;
  return {
    model: c.model ?? model,
    input: n(c.input_tokens),
    cacheRead: n(c.cache_read_input_tokens),
    cacheWrite5m: written - w1,
    cacheWrite1h: w1,
    output: n(c.output_tokens),
    reasoning: 0,
  };
}

function readCalls(input: CostInput): { calls: Call[]; serverTools: Record<string, number> } | null {
  const { protocol, model, usage } = input;
  const fields = input.usageFields;
  switch (protocol) {
    case "anthropic-messages": {
      const u = AnthropicUsage.safeParse(usage);
      if (!u.success) return null;
      const serverTools: Record<string, number> = {};
      for (const [key, value] of Object.entries(u.data.server_tool_use ?? {})) {
        const count = Count.safeParse(value);
        if (count.success && count.data) serverTools[key.replace(/_requests$/, "")] = count.data;
      }
      const sources = u.data.iterations && u.data.iterations.length > 0 ? u.data.iterations : [u.data];
      const calls = sources.map((c) => anthropicCall(model, c));
      return calls.every((c): c is Call => c !== null) ? { calls, serverTools } : null;
    }
    case "openai-responses": {
      const u = ResponsesUsage.safeParse(usage);
      if (!u.success || (u.data.input_tokens === undefined && u.data.output_tokens === undefined))
        return sdkShape(input);
      const call = splitPrompt(
        model,
        n(u.data.input_tokens),
        n(u.data.input_tokens_details?.cached_tokens),
        n(u.data.output_tokens),
        n(u.data.output_tokens_details?.reasoning_tokens),
      );
      return call && { calls: [call], serverTools: {} };
    }
    case "google-interactions": {
      const u = GoogleUsage.safeParse(usage);
      if (!u.success || (u.data.total_input_tokens === undefined && u.data.total_output_tokens === undefined)) {
        return sdkShape(input);
      }
      const thought = n(u.data.total_thought_tokens);
      const call = splitPrompt(
        model,
        n(u.data.total_input_tokens),
        n(u.data.total_cached_tokens),
        n(u.data.total_output_tokens) + thought,
        thought,
      );
      return call && { calls: [call], serverTools: {} };
    }
    case "openai-chat": {
      const u = ChatUsage.safeParse(usage);
      if (!u.success || (u.data.prompt_tokens === undefined && u.data.completion_tokens === undefined)) {
        return sdkShape(input);
      }
      const total = n(u.data.prompt_tokens);
      const miss = pathCount(usage, fields?.cacheMiss);
      const cached =
        pathCount(usage, fields?.cachedInput) ??
        (miss === undefined ? undefined : total - miss) ??
        n(u.data.prompt_tokens_details?.cached_tokens);
      const reasoning =
        pathCount(usage, fields?.reasoningOutput) ?? n(u.data.completion_tokens_details?.reasoning_tokens);
      const call = splitPrompt(model, total, cached, n(u.data.completion_tokens), reasoning);
      return call && { calls: [call], serverTools: {} };
    }
  }
}

function sdkShape(input: CostInput): { calls: Call[]; serverTools: Record<string, number> } | null {
  const u = SdkUsage.safeParse(input.usage);
  if (!u.success) return null;
  const { inputTokens: i, outputTokens: o } = u.data;
  if (i.total === undefined && o.total === undefined) return null;
  const cacheRead = n(i.cacheRead);
  const written = n(i.cacheWrite);
  const total = i.total ?? n(i.noCache) + cacheRead + written;
  if (cacheRead + written > total) return null;
  const output = n(o.total);
  if (n(o.reasoning) > output) return null;
  const call: Call = {
    model: input.model,
    input: i.noCache ?? total - cacheRead - written,
    cacheRead,
    cacheWrite5m: written,
    cacheWrite1h: 0,
    output,
    reasoning: n(o.reasoning),
  };
  return { calls: [call], serverTools: {} };
}

type Priced = { usd: number | null; approximate: boolean };

function priceCall(call: Call, { price, rule }: ModelRates): Priced {
  if (price === null) return { usd: null, approximate: false };
  const prompt = call.input + call.cacheRead + call.cacheWrite5m + call.cacheWrite1h;
  const tier = price.tiers?.filter((t) => prompt > t.size).sort((a, b) => b.size - a.size)[0];
  const rates: PriceRates = tier ?? price;
  let approximate = false;
  const rate = (tokens: number, value: number | undefined, fallback: number): number => {
    if (tokens === 0) return 0;
    if (value === undefined) approximate = true;
    return tokens * (value ?? fallback);
  };
  let sum = call.input * rates.input;
  sum += rate(call.cacheRead, rates.cacheRead, rates.input);
  const write5m =
    rates.cacheWrite ??
    (rule?.cacheWrite5mMultiplier === undefined ? undefined : rates.input * rule.cacheWrite5mMultiplier);
  sum += rate(call.cacheWrite5m, write5m, rates.input);
  const write1h = rule?.cacheWrite1hMultiplier === undefined ? undefined : rates.input * rule.cacheWrite1hMultiplier;
  sum += rate(call.cacheWrite1h, write1h, write5m ?? rates.input);
  const reasoning = tier === undefined ? price.reasoning : undefined;
  const reasoningTokens = reasoning === undefined ? 0 : call.reasoning;
  sum += (call.output - reasoningTokens) * rates.output + reasoningTokens * (reasoning ?? 0);
  return { usd: sum / PER_M, approximate };
}

export function computeCost(input: CostInput): Cost {
  const read = readCalls(input);
  const planBilled = input.billing === "plan";
  const tokens: TokenTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const models = [input.model];
  const unknown: Cost = { usd: null, approximate: false, planBilled, models, tokens };
  if (read === null) return unknown;
  for (const c of read.calls) {
    tokens.input += c.input;
    tokens.cacheRead += c.cacheRead;
    tokens.cacheWrite += c.cacheWrite5m + c.cacheWrite1h;
    tokens.output += c.output;
    if (!models.includes(c.model)) models.push(c.model);
  }
  const refusal = input.refusal;
  const result: Cost = refusal === undefined ? unknown : { ...unknown, refusalCategory: refusal.category };
  if (planBilled) return result;

  if (
    refusal?.beforeOutput &&
    input.protocol === "anthropic-messages" &&
    !BILLED_REFUSAL_CATEGORIES.has(refusal.category)
  ) {
    return { ...result, usd: 0 };
  }

  let tokenUsd = 0;
  let approximate = false;
  for (const call of read.calls) {
    const rates = input.rates(call.model);
    const priced = priceCall(call, rates);
    if (priced.usd === null) return result;
    const residency =
      input.inferenceGeo === "us" && rates.rule?.residencyMultiplier !== undefined ? rates.rule.residencyMultiplier : 1;
    tokenUsd += priced.usd * residency * (input.endpointMultiplier ?? 1);
    approximate ||= priced.approximate;
  }
  let feesUsd = 0;
  const answering = input.rates(input.model).rule;
  for (const [tool, count] of Object.entries(read.serverTools)) {
    const fee = answering?.serverToolUsd?.[tool];
    if (fee === undefined) approximate = true;
    else feesUsd += count * fee;
  }
  return { ...result, usd: tokenUsd + feesUsd, approximate };
}

export function formatCost(cost: Cost): string {
  if (cost.planBilled) return "billed to plan allowance";
  if (cost.usd === null) return "?";
  const mark = cost.approximate ? "≈" : "";
  if (cost.usd === 0) return `${mark}$0.00`;
  if (cost.usd >= 0.01) return `${mark}$${cost.usd.toFixed(2)}`;
  if (cost.usd < 0.00005) return `${mark}<$0.0001`;
  return `${mark}$${cost.usd.toFixed(4)}`;
}
