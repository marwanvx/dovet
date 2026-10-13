import type { Settings } from "../../schema/index.ts";
import { put } from "./parse.ts";

export type SettingsSource =
  | "default"
  | "claude-user"
  | "user"
  | "claude-project"
  | "project"
  | "claude-local"
  | "local"
  | "env"
  | "flags";
export type Layer = { source: SettingsSource; file?: string; settings: Settings };
export type SourcedRule = { rule: string; source: SettingsSource; file?: string };
export type RuleKind = "allow" | "ask" | "deny";

const RULE_LISTS = new Set(["permissions.allow", "permissions.ask", "permissions.deny"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge(low: unknown, high: unknown, path: string): unknown {
  if (high === undefined) return low;
  if (isObject(low) && isObject(high)) {
    const out = {};
    for (const key of new Set([...Object.keys(low), ...Object.keys(high)])) {
      put(out, key, merge(low[key], high[key], path === "" ? key : `${path}.${key}`));
    }
    return out;
  }
  if (Array.isArray(low) && Array.isArray(high) && RULE_LISTS.has(path)) return [...new Set([...low, ...high])];
  return high;
}

/** Objects deep-merge, rule lists concatenate, every other array and scalar comes from the higher level. Layers run lowest first. */
export function mergeLayers(layers: readonly Layer[]): Settings {
  // The layers are validated Settings, and merging two valid objects key by key stays valid.
  return layers.reduce<unknown>((acc, layer) => merge(acc, layer.settings, ""), {}) as Settings;
}

export function collectRules(layers: readonly Layer[]): Record<RuleKind, SourcedRule[]> {
  const out: Record<RuleKind, SourcedRule[]> = { allow: [], ask: [], deny: [] };
  for (const layer of layers) {
    for (const kind of ["allow", "ask", "deny"] as const) {
      for (const rule of layer.settings.permissions?.[kind] ?? []) {
        out[kind].push({ rule, source: layer.source, ...(layer.file === undefined ? {} : { file: layer.file }) });
      }
    }
  }
  return out;
}
