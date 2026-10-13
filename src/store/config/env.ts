import { Settings } from "../../schema/index.ts";
import type { Problem } from "./errors.ts";

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A number that is written as one: `1e2` is 100, `5abc`, `0x10` and `Infinity` are not numbers. */
export function parseStrictNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!PLAIN_NUMBER.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export type EnvLayer = { settings: Settings; warnings: Problem[]; problems: Problem[] };

/** Level 2: DOVET_MODEL, DOVET_PROVIDER, DOVET_EFFORT, DOVET_BUDGET (the session limit, ASSUMPTION QUESTIONS Q20). */
export function envSettings(env: Readonly<Record<string, string | undefined>>): EnvLayer {
  const settings: Settings = {};
  const warnings: Problem[] = [];
  const problems: Problem[] = [];
  const get = (name: string): string | undefined => (env[name] === "" ? undefined : env[name]);
  const issue = (key: string, message: string): Problem => ({ file: "environment", key, message });

  const model = get("DOVET_MODEL");
  if (model !== undefined) settings.model = model;
  const provider = get("DOVET_PROVIDER");
  if (provider !== undefined) settings.provider = provider;

  const effort = get("DOVET_EFFORT");
  if (effort !== undefined) {
    const parsed = Settings.shape.effort.safeParse(effort);
    if (parsed.success) settings.effort = parsed.data;
    else
      warnings.push(issue("DOVET_EFFORT", `ignored: expected one of low, medium, high, xhigh, max (got "${effort}")`));
  }

  const budget = get("DOVET_BUDGET");
  if (budget !== undefined) {
    const n = parseStrictNumber(budget);
    if (n === undefined || n < 0) {
      problems.push(
        issue("DOVET_BUDGET", `expected a non-negative number of US dollars such as 5 or 2.5e1 (got "${budget}")`),
      );
    } else {
      settings.budget = { session: n };
    }
  }
  return { settings, warnings, problems };
}
