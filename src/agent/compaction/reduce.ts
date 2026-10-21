// The reduced copy a summary request uses when the full transcript would not fit (context §6 procedure 3b).
import type { TranscriptItem } from "../../ai/index.ts";
import type { Part } from "../../schema/index.ts";
import { estimateContext } from "./estimate.ts";

const KEEP_CHARS = 1000;

type Media = Extract<Part, { kind: "image" | "document" }>;

function placeholder(m: Media): Part {
  const id = m.blob.id.slice(0, 8);
  const name = m.kind === "image" ? `${id}.${m.mediaType.slice("image/".length)}` : (m.title ?? `${id}.pdf`);
  return { kind: "text", text: `[${m.kind}: ${name}]` };
}

const withoutMedia = (p: Part): Part => {
  if (p.kind === "image" || p.kind === "document") return placeholder(p);
  if (p.kind !== "tool_result") return p;
  return { ...p, content: p.content.map((c) => (c.kind === "text" ? c : (placeholder(c) as typeof c))) };
};

function cutText(text: string): string {
  if (text.length <= 2 * KEEP_CHARS) return text;
  let head = KEEP_CHARS;
  if (text.charCodeAt(head - 1) >= 0xd800 && text.charCodeAt(head - 1) <= 0xdbff) head -= 1;
  let tail = text.length - KEEP_CHARS;
  if (text.charCodeAt(tail) >= 0xdc00 && text.charCodeAt(tail) <= 0xdfff) tail += 1;
  return `${text.slice(0, head)}\n[… ${tail - head} characters left out of this copy …]\n${text.slice(tail)}`;
}

const cutResult = (p: Part): Part =>
  p.kind === "tool_result"
    ? { ...p, content: p.content.map((c) => (c.kind === "text" ? { ...c, text: cutText(c.text) } : c)) }
    : p;

const mapUser = (items: TranscriptItem[], f: (p: Part) => Part): TranscriptItem[] =>
  items.map((i) => (i.kind === "user" ? { ...i, parts: i.parts.map(f) } : i));

/**
 * Steps in order until `items` fits `budget` tokens: images become placeholders, tool results keep their first and last
 * 1,000 characters, the oldest turns are dropped (always keeping the first message and the last item).
 * `extraChars` is the text the caller appends afterwards (the compaction prompt).
 */
export function reduceForSummary(
  items: TranscriptItem[],
  opts: { budget: number; extraChars: number; imageTokens: number },
): { items: TranscriptItem[]; reduced: boolean } {
  const size = (list: TranscriptItem[]): number =>
    estimateContext({ mark: null, transcript: list, fixedChars: opts.extraChars, imageTokens: opts.imageTokens });
  if (size(items) <= opts.budget) return { items, reduced: false };
  let out = mapUser(items, withoutMedia);
  if (size(out) > opts.budget) out = mapUser(out, cutResult);
  let dropped = 0;
  while (size(out) > opts.budget && out.length > 2) {
    let k = 2;
    while (k < out.length - 1 && !(out[k]?.kind === "user" && out[k - 1]?.kind === "assistant")) k += 1;
    if (!(out[k]?.kind === "user" && out[k - 1]?.kind === "assistant") || k >= out.length - 1) break;
    out = [out[0] as TranscriptItem, ...out.slice(k + 1)];
    dropped += k;
  }
  const first = out[0];
  if (dropped > 0 && first?.kind === "user")
    out[0] = {
      ...first,
      parts: [...first.parts, { kind: "text", text: `[${dropped} older messages were left out of this copy.]` }],
    };
  return { items: out, reduced: true };
}
