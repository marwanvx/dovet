// Provider records (providers "Provider registry", interfaces §2b); only the fields M1 uses so far.
import { z } from "zod";
import { Protocol } from "../schema/index.ts";
import type { ProviderAuth } from "../store/index.ts";
import curated from "./providers.jsonc";

const Quirks = z.strictObject({
  reasoningField: z.enum(["reasoning_content", "reasoning_details"]).nullable().optional(),
  effortField: z.literal("reasoning_effort").nullable().optional(),
  reasoningReplay: z.enum(["in-tool-loop", "always", "never"]).optional(),
});

const Endpoint = z.strictObject({
  id: z.string(),
  region: z.string(),
  plan: z.enum(["platform", "coding-plan", "chatgpt-plan"]),
  package: z.string(),
  protocol: Protocol,
  baseUrl: z.url(),
  billing: z.enum(["per-token", "plan"]),
  models: z.union([z.enum(["catalog", "endpoint"]), z.strictObject({ static: z.array(z.string()) })]),
  quirks: Quirks.optional(),
  capabilities: z.strictObject({ effortLevels: z.array(z.string()).optional() }).optional(),
});

const ProviderRecord = z.strictObject({
  id: z.string(),
  name: z.string(),
  docsUrl: z.url().optional(),
  status: z.enum(["tested", "community"]),
  endpoints: z.array(Endpoint).min(1),
  auth: z.array(z.strictObject({ method: z.literal("api-key"), envVars: z.array(z.string()) })),
});
export type ProviderRecord = z.infer<typeof ProviderRecord>;
export type Quirks = z.infer<typeof Quirks>;

export function parseRecords(raw: unknown): ProviderRecord[] {
  const parsed = z.array(ProviderRecord).safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`provider record ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
}

const RECORDS: readonly ProviderRecord[] = parseRecords(curated);

export function providerRecord(id: string): ProviderRecord {
  const record = RECORDS.find((r) => r.id === id);
  if (record === undefined) throw new Error(`no provider record "${id}"`);
  return record;
}

/** The record's first endpoint, as the adapter takes it (region and plan choice come with the M4 registry). */
export function endpointOf(record: ProviderRecord) {
  const [endpoint] = record.endpoints;
  if (endpoint === undefined) throw new Error(`provider record "${record.id}" has no endpoint`);
  return {
    package: endpoint.package,
    baseURL: endpoint.baseUrl,
    quirks: endpoint.quirks ?? {},
    effortLevels: endpoint.capabilities?.effortLevels ?? [],
  };
}

export const PROVIDER_AUTH: Readonly<Record<string, ProviderAuth>> = Object.fromEntries(
  RECORDS.map((r) => [r.id, { id: r.id, envVars: r.auth.flatMap((a) => a.envVars) }]),
);
