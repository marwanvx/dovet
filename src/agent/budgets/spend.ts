// What one response cost, for the budgets: catalog prices where there are any, the live meter's placeholder rates otherwise.
import { computeCost, type ModelRates, type TokenTotals } from "../../ai/index.ts";
import type { Protocol } from "../../schema/index.ts";
import { PLACEHOLDER_RATES } from "./estimate.ts";

export type Spend = { usd: number; tokens: TokenTotals; planBilled: boolean };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const nested = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;

/** Token counts of the shapes the placeholder meter has always read, for usage `computeCost` cannot read. */
function looseTokens(u: Record<string, unknown>): TokenTotals {
  const input = num(nested(u.inputTokens, "total")) || num(u.promptTokens) || num(u.prompt_tokens);
  const output = num(nested(u.outputTokens, "total")) || num(u.completionTokens) || num(u.completion_tokens);
  return { input, cacheRead: 0, cacheWrite: 0, output };
}

/** No model has a catalog price before M4-02, so every response is still costed with the placeholder rates. */
const NO_PRICE = (): ModelRates => ({ price: null });

export function responseSpend(args: {
  protocol: Protocol;
  model: string;
  usage: Record<string, unknown>;
  billing: "per-token" | "plan";
  rates?: (model: string) => ModelRates;
}): Spend {
  const cost = computeCost({
    protocol: args.protocol,
    model: args.model,
    usage: args.usage,
    rates: args.rates ?? NO_PRICE,
    billing: args.billing,
  });
  const t = cost.tokens;
  const known = t.input + t.cacheRead + t.cacheWrite + t.output > 0;
  const tokens = known ? t : looseTokens(args.usage);
  if (cost.planBilled) return { usd: 0, tokens, planBilled: true };
  if (cost.usd !== null) return { usd: cost.usd, tokens, planBilled: false };
  const reported = args.usage.cost;
  if (typeof reported === "number" && Number.isFinite(reported)) return { usd: reported, tokens, planBilled: false };
  const { input, output } = PLACEHOLDER_RATES;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const usd = prompt + tokens.output > 0 ? (prompt * input + tokens.output * output) / 1e6 : 0.001;
  return { usd, tokens, planBilled: false };
}
