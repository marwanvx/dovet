// Tool lookup, input normalization and validation with an example call on failure (tools §0, interfaces §4).
import type { z } from "zod";
import type { ToolCallData } from "../schema/index.ts";
import { normalizeInput } from "./normalize.ts";
import { toolInputSchema } from "./schema.ts";
import type { ToolDefinition } from "./types.ts";

export type PreparedCall =
  | { ok: true; tool: ToolDefinition<unknown>; raw: unknown; normalized: unknown; input: unknown }
  | { ok: false; message: string };

export interface ToolRegistry {
  readonly tools: readonly ToolDefinition<unknown>[];
  prepare(name: string, raw: unknown): PreparedCall;
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => (issue.path.length > 0 ? `- ${issue.path.join(".")}: ${issue.message}` : `- ${issue.message}`))
    .join("\n");
}

function hasNullByte(value: unknown): boolean {
  return typeof value === "string" && value.includes("\0");
}

export function createToolRegistry(defs: readonly ToolDefinition<unknown>[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition<unknown>>();
  for (const def of defs) {
    if (byName.has(def.name)) throw new Error(`Duplicate tool name ${def.name}`);
    byName.set(def.name, def);
  }
  const schemas = new Map(
    defs.map((d) => [d.name, toolInputSchema(d) as { properties?: Record<string, { type?: unknown }> }]),
  );
  const available = [...byName.keys()].sort().join(", ");

  function find(name: string): ToolDefinition<unknown> | undefined {
    const exact = byName.get(name);
    if (exact) return exact;
    const folded = defs.filter((d) => d.name.toLowerCase() === name.toLowerCase());
    return folded.length === 1 ? folded[0] : undefined;
  }

  return {
    tools: defs,
    prepare(name, raw) {
      const tool = find(name);
      if (!tool) return { ok: false, message: `Unknown tool ${name}. Available: ${available}` };
      const example = `Example call: ${JSON.stringify(tool.errorExample)}`;
      const normalized = normalizeInput(raw, tool.normalize, schemas.get(tool.name) ?? {});
      if ("conflict" in normalized)
        return { ok: false, message: `Invalid input for ${tool.name}: ${normalized.conflict}\n${example}` };
      const parsed = tool.input.safeParse(normalized.value);
      if (!parsed.success) {
        return {
          ok: false,
          message: `Invalid input for ${tool.name}:\n${describeIssues(parsed.error.issues)}\n${example}`,
        };
      }
      const record = parsed.data as Record<string, unknown>;
      for (const field of tool.pathFields ?? []) {
        if (hasNullByte(record[field])) return { ok: false, message: `Remove the null byte from ${field}.` };
      }
      return { ok: true, tool, raw, normalized: normalized.value, input: parsed.data };
    },
  };
}

export function toolCallData(callId: string, call: Extract<PreparedCall, { ok: true }>): ToolCallData {
  return {
    callId,
    name: call.tool.name,
    raw: call.raw as ToolCallData["raw"],
    input: call.normalized as ToolCallData["input"],
  };
}
