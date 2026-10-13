// Cache-miss diagnosis (providers §3 "Cache-miss diagnosis") and the cache-read monitor (context §7, AC-CTX-04).
import { z } from "zod";
import type { SdkCall } from "../../ai/index.ts";
import type { PrefixFingerprint } from "../../schema/index.ts";

const sha256 = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

/** SHA-256 of the tools, the leading system message and each message after it, as rendered. */
export function prefixFingerprint(call: Pick<SdkCall, "tools" | "messages">): PrefixFingerprint {
  if (!Array.isArray(call.messages)) throw new Error("a rendered call has a message list");
  const messages: unknown[] = call.messages;
  const first = messages[0];
  const hasSystem = typeof first === "object" && first !== null && "role" in first && first.role === "system";
  return {
    tools: sha256(call.tools),
    system: sha256(hasSystem ? first : null),
    messages: messages.slice(hasSystem ? 1 : 0).map(sha256),
  };
}

export type Divergence = { part: "tools" } | { part: "system" } | { part: "message"; index: number };

/** Where `next` stops being an extension of `prev`; null when it extends it. */
export function firstDivergence(prev: PrefixFingerprint, next: PrefixFingerprint): Divergence | null {
  if (prev.tools !== next.tools) return { part: "tools" };
  if (prev.system !== next.system) return { part: "system" };
  for (const [index, hash] of prev.messages.entries()) {
    if (next.messages[index] !== hash) return { part: "message", index };
  }
  return null;
}

const Usage = z.object({
  cache_read_input_tokens: z.number().nonnegative().optional(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().nonnegative().optional() }).optional(),
});

/** Cache-read tokens from a raw usage object (Anthropic or OpenAI shape); undefined when the provider reports none. */
export function cacheReadOf(usage: Record<string, unknown>): number | undefined {
  const parsed = Usage.safeParse(usage);
  if (!parsed.success) return undefined;
  return parsed.data.cache_read_input_tokens ?? parsed.data.prompt_tokens_details?.cached_tokens;
}

export type CacheSample = { turn: number; cacheReadTokens: number | undefined; expectedMiss?: boolean };
export type CacheWarning = {
  text: string;
  invariant: { kind: "cache-read-drop"; turn: number; previous: number; current: number };
};

/** ASSUMPTION (QUESTIONS Q31): "the previous request's prefix" is the previous request's cache-read tokens. */
export function cacheWarning(prev: CacheSample | undefined, now: CacheSample): CacheWarning | null {
  const previous = prev?.cacheReadTokens;
  const current = now.cacheReadTokens;
  if (now.turn <= 3 || now.expectedMiss === true || previous === undefined || current === undefined) return null;
  if (previous === 0 || current >= previous / 2) return null;
  return {
    text: `Prompt cache reads fell from ${previous} to ${current} tokens. Run /why --cache to see the first block that changed.`,
    invariant: { kind: "cache-read-drop", turn: now.turn, previous, current },
  };
}
