// The frozen epoch header (context §1) and the `epoch.start` event that stores it.
import type { EpochHeader, ToolDef } from "../../ai/index.ts";
import type { EpochStartData } from "../../schema/index.ts";
import { PROMPT_VERSION } from "./prompts.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
  return out;
}

/** Sorted by name, schema keys in sorted order: the same tool set always gives the same bytes. */
export function serializeTools(tools: readonly ToolDef[]): string {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const [i, t] of sorted.entries()) {
    if (i > 0 && sorted[i - 1]?.name === t.name) throw new Error(`two tools are named ${t.name}`);
  }
  return JSON.stringify(
    sorted.map((t) => ({ name: t.name, description: t.description, inputSchema: canonical(t.inputSchema) })),
  );
}

export function startEpoch(input: Omit<EpochStartData, "promptVersion">): {
  header: EpochHeader;
  event: EpochStartData;
} {
  const event: EpochStartData = { ...input, promptVersion: PROMPT_VERSION };
  return { header: headerOf(event), event };
}

/** Resume and replay rebuild the header from the stored event, never from a re-render. */
export function headerOf(event: EpochStartData): EpochHeader {
  const { reason: _, thinking, ...header } = event;
  const { budgetTokens } = thinking;
  return { ...header, thinking: { mode: thinking.mode, ...(budgetTokens === undefined ? {} : { budgetTokens }) } };
}
