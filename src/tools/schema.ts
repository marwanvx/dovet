// The JSON Schema a tool is declared with, kept inside the strict-tools subset (providers "Valid tool calls by construction").
import { z } from "zod";
import type { ToolDefinition } from "./types.ts";

type Node = Record<string, unknown>;

const LIMITS: Record<string, (n: number) => string> = {
  minimum: (n) => `at least ${n}`,
  maximum: (n) => `at most ${n}`,
  exclusiveMinimum: (n) => `greater than ${n}`,
  exclusiveMaximum: (n) => `less than ${n}`,
  minLength: (n) => `at least ${n} characters`,
  maxLength: (n) => `at most ${n} characters`,
  minItems: (n) => `at least ${n} items`,
  maxItems: (n) => `at most ${n} items`,
};

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

function moveLimits(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) moveLimits(item);
    return;
  }
  if (!isNode(node)) return;
  const notes: string[] = [];
  for (const [key, describe] of Object.entries(LIMITS)) {
    const value = node[key];
    if (typeof value !== "number") continue;
    delete node[key];
    if (Math.abs(value) !== Number.MAX_SAFE_INTEGER) notes.push(describe(value));
  }
  if (notes.length > 0) {
    const text = `(${notes.join(", ")})`;
    node.description = typeof node.description === "string" ? `${node.description} ${text}` : text;
  }
  for (const value of Object.values(node)) moveLimits(value);
}

/** Zod's own limits are enforced by validation; the declared schema carries them as words. */
export function toolInputSchema(tool: Pick<ToolDefinition<unknown>, "input">): Node {
  const schema = z.toJSONSchema(tool.input, { io: "input" }) as Node;
  delete schema.$schema;
  moveLimits(schema);
  return schema;
}

export function strictSubsetViolations(schema: unknown, at = "$"): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, i) => strictSubsetViolations(item, `${at}[${i}]`));
  if (!isNode(schema)) return [];
  const found: string[] = [];
  if ((schema.type === "object" || isNode(schema.properties)) && schema.additionalProperties !== false) {
    found.push(`${at}: object without additionalProperties: false`);
  }
  for (const key of Object.keys(LIMITS)) {
    if (typeof schema[key] === "number") found.push(`${at}: ${key} is outside the strict subset`);
  }
  if (typeof schema.$ref === "string")
    found.push(`${at}: $ref (recursive or shared schemas are outside the strict subset)`);
  for (const [key, value] of Object.entries(schema)) found.push(...strictSubsetViolations(value, `${at}.${key}`));
  return found;
}
