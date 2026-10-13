import type { Node } from "jsonc-parser";
import { z } from "zod";
import { Settings } from "../../schema/index.ts";
import type { Problem } from "./errors.ts";
import { formatKey, locate, type Segment } from "./parse.ts";

export type Validated = { value: Settings; warnings: Problem[]; problems: Problem[] };
export type ValidateOptions = {
  file: string;
  text?: string;
  tree?: Node | undefined;
  /** Files written for another tool: unknown keys are dropped silently and every issue is a warning. */
  lenient?: boolean;
};

const POLICY_SECTIONS = new Set(["permissions", "sandbox", "env", "budget"]);
const MAX_PASSES = 200;

/** Policy keys (cli-config "Format") stop startup when invalid; the rest are ignored with a warning. */
function isPolicy(path: readonly Segment[]): boolean {
  const [section, , field] = path;
  if (path.length === 0) return true;
  if (typeof section === "string" && POLICY_SECTIONS.has(section)) return true;
  return section === "providers" && (path.length < 3 || field === "apiKey" || field === "baseUrl");
}

function childSchema(schema: z.ZodType | undefined, seg: Segment): z.ZodType | undefined {
  let s = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap() as z.ZodType;
  if (s instanceof z.ZodObject) return (s.shape as Record<string, z.ZodType>)[String(seg)];
  if (s instanceof z.ZodRecord) return s.valueType as z.ZodType;
  if (s instanceof z.ZodArray) return s.element as z.ZodType;
  return undefined;
}

function knownKeys(path: readonly Segment[]): string[] {
  let s: z.ZodType | undefined = Settings;
  for (const seg of path) s = childSchema(s, seg);
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap() as z.ZodType;
  return s instanceof z.ZodObject ? Object.keys(s.shape) : [];
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

function suggest(key: string, candidates: string[]): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const name of candidates) {
    const d = distance(key.toLowerCase(), name.toLowerCase());
    if (d <= Math.max(2, Math.floor(name.length / 3)) && (best === undefined || d < best.d)) best = { name, d };
  }
  return best?.name;
}

function describe(issue: z.core.$ZodIssue): string {
  if (issue.code === "invalid_union") {
    const parts = issue.errors.flat().map((i) => i.message);
    return [...new Set(parts)].join(" or ");
  }
  return issue.message;
}

function parentOf(data: unknown, path: readonly Segment[]): Record<string, unknown> | unknown[] | undefined {
  let node: unknown = data;
  for (const seg of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[String(seg)];
  }
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>) : undefined;
}

function remove(data: unknown, path: readonly Segment[]): void {
  const last = path[path.length - 1];
  const parent = parentOf(data, path.slice(0, -1));
  if (last !== undefined && parent !== undefined && !Array.isArray(parent)) delete parent[String(last)];
}

export function validateSettings(raw: unknown, opts: ValidateOptions): Validated {
  const warnings: Problem[] = [];
  const problems: Problem[] = [];
  const at = (path: Segment[], message: string): Problem => ({
    file: opts.file,
    line: locate(opts.text, opts.tree, path),
    key: formatKey(path),
    message,
  });
  const data: unknown = raw;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const parsed = Settings.safeParse(data);
    if (parsed.success) return { value: parsed.data, warnings, problems };

    for (const issue of parsed.error.issues) {
      const path = issue.path.map((p) => (typeof p === "number" ? p : String(p)));
      if (issue.code === "unrecognized_keys") {
        const parent = parentOf(data, path);
        for (const key of issue.keys) {
          if (!opts.lenient) {
            const hint = suggest(key, knownKeys(path));
            warnings.push(at([...path, key], hint ? `unknown key; did you mean "${hint}"?` : "unknown key (ignored)"));
          }
          if (parent !== undefined && !Array.isArray(parent)) delete parent[key];
        }
        continue;
      }
      if (path.length === 0) {
        problems.push(at(path, `expected a JSON object (${describe(issue)})`));
        return { value: {}, warnings, problems };
      }
      const wholeArray = typeof path[path.length - 1] === "number";
      const target = wholeArray ? path.slice(0, path.findLastIndex((s) => typeof s === "string") + 1) : path;
      const entry = at(path, describe(issue));
      (isPolicy(path) && !opts.lenient ? problems : warnings).push(entry);
      remove(data, target);
    }
  }
  throw new Error(`settings validation did not settle for ${opts.file}`);
}
