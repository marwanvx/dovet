// The context estimate and the compaction triggers (context §6 "Token estimate" and "Triggers").
import type { TokenTotals, TranscriptItem } from "../../ai/index.ts";
import type { Part } from "../../schema/index.ts";
import { CHARS_PER_TOKEN } from "../budgets/estimate.ts";

/** Per image when the catalog has no `imageTokens` (context §6). */
export const DEFAULT_IMAGE_TOKENS = 1600;

/** The last response's usage with the size of the transcript it answered. */
export type ContextMark = { tokens: TokenTotals; chars: number; images: number };

function partChars(p: Part): number {
  switch (p.kind) {
    case "text":
    case "instruction":
      return p.text.length;
    case "reasoning":
      return p.summary?.length ?? 0;
    case "tool_call":
      return p.name.length + p.inputJson.length;
    case "tool_result":
      return p.content.reduce((n, c) => n + (c.kind === "text" ? c.text.length : 0), 0);
    default:
      return 0;
  }
}

/** Characters of text only: image bytes are priced per image, never per character. */
export function transcriptChars(items: readonly TranscriptItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === "system") n += item.text.length;
    else for (const p of item.kind === "user" ? item.parts : item.stored.parts) n += partChars(p);
  }
  return n;
}

const isMedia = (p: { kind: string }): boolean => p.kind === "image" || p.kind === "document";

export function countImages(items: readonly TranscriptItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === "system") continue;
    for (const p of item.kind === "user" ? item.parts : item.stored.parts) {
      if (isMedia(p)) n += 1;
      else if (p.kind === "tool_result") n += p.content.filter(isMedia).length;
    }
  }
  return n;
}

export const tokensOf = (t: TokenTotals): number => t.input + t.cacheRead + t.cacheWrite + t.output;

/**
 * `fixedChars` is the system prompt and tool definitions, which only the whole-request fallback needs: a real usage
 * report already includes them. A mark with zero tokens counts as no usage at all.
 */
export function estimateContext(args: {
  mark: ContextMark | null;
  transcript: readonly TranscriptItem[];
  fixedChars: number;
  imageTokens: number;
}): number {
  const chars = transcriptChars(args.transcript);
  const images = countImages(args.transcript);
  const { mark } = args;
  if (mark === null || tokensOf(mark.tokens) === 0)
    return Math.ceil((args.fixedChars + chars) / CHARS_PER_TOKEN) + images * args.imageTokens;
  const reported = tokensOf(mark.tokens);
  const appended = Math.max(0, chars - mark.chars);
  return reported + Math.ceil(appended / CHARS_PER_TOKEN) + Math.max(0, images - mark.images) * args.imageTokens;
}

/** Above the threshold share of the usable window (window minus the output reserve), or the absolute cap if lower. */
export function shouldCompact(args: {
  tokens: number;
  window: number;
  reserve: number;
  threshold: number;
  maxTokens: number | null;
}): boolean {
  const limit = (args.window - args.reserve) * args.threshold;
  return args.tokens > (args.maxTokens === null ? limit : Math.min(limit, args.maxTokens));
}

/** An assistant turn with tool calls no later message answers: compaction waits for the results. */
export function hasOpenRound(items: readonly TranscriptItem[]): boolean {
  const open = new Set<string>();
  for (const item of items) {
    if (item.kind === "assistant") {
      for (const p of item.stored.parts) if (p.kind === "tool_call") open.add(p.id);
    } else if (item.kind === "user") {
      for (const p of item.parts) if (p.kind === "tool_result") open.delete(p.callId);
    }
  }
  return open.size > 0;
}
