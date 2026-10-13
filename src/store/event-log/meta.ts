import { z } from "zod";
import type { EventEnvelope } from "../../schema/index.ts";

export const SessionMeta = z.object({
  id: z.string(),
  title: z.string(),
  created: z.string(),
  updated: z.string(),
  turns: z.number().int().nonnegative(),
  /** Log size when this was written; a different size means the sidecar is stale. */
  bytes: z.number().int().nonnegative(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

const TITLE_CHARS = 60;

export function emptyMeta(id: string): SessionMeta {
  return { id, title: "", created: "", updated: "", turns: 0, bytes: 0 };
}

export function foldMeta(meta: SessionMeta, e: Pick<EventEnvelope, "ts" | "type" | "data">): SessionMeta {
  const next = { ...meta, created: meta.created || e.ts, updated: e.ts };
  if (e.type === "turn.end") next.turns += 1;
  if (e.type === "user.message" && meta.title === "") {
    const text = (e.data as { text?: unknown } | null)?.text;
    if (typeof text === "string") next.title = text.slice(0, TITLE_CHARS).trimEnd();
  }
  return next;
}
