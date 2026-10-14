// Deterministic input normalization before validation (tools §0): each saved retry is a model round trip.
import type { InputNormalization } from "./types.ts";

export type NormalizeResult = { value: unknown } | { conflict: string };

const NUMERIC = /^\s*[+-]?\d+\s*$/;

export function normalizeInput(
  raw: unknown,
  rules: InputNormalization | undefined,
  schema: { properties?: Record<string, { type?: unknown }> },
): NormalizeResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { value: raw };
  let input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (value !== null) input[key] = value;

  for (const [alias, real] of Object.entries(rules?.aliases ?? {})) {
    if (!(alias in input)) continue;
    const given = input[alias];
    delete input[alias];
    if (!(real in input)) input[real] = given;
    else if (!Bun.deepEquals(input[real], given)) {
      return { conflict: `Both \`${alias}\` and \`${real}\` were given with different values; send only \`${real}\`.` };
    }
  }

  const properties = schema.properties ?? {};
  const dropped = new Set(rules?.drop ?? []);
  if (!("description" in properties)) dropped.add("description");
  for (const key of dropped) if (!(key in properties)) delete input[key];

  for (const [key, value] of Object.entries(input)) {
    if (properties[key]?.type === "integer" && typeof value === "string" && NUMERIC.test(value)) {
      input[key] = Number(value);
    }
  }
  if (rules?.rewrite) input = rules.rewrite(input);
  return { value: input };
}
