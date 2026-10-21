import { z } from "zod";
import type { EventEnvelope } from "../../schema/index.ts";

export const ResumeSnapshot = z.object({
  mode: z.string(),
  taint: z.array(z.string()),
  turn: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  provider: z.string(),
  model: z.string(),
});
export type ResumeSnapshot = z.infer<typeof ResumeSnapshot>;

export const SessionMeta = z.object({
  id: z.string(),
  title: z.string(),
  created: z.string(),
  updated: z.string(),
  turns: z.number().int().nonnegative(),
  lastId: z.string(),
  /** Log size when this was written; a different size means the sidecar is stale. */
  bytes: z.number().int().nonnegative(),
  /** Resume fast path: byte offset and event id of the latest `epoch.start`, with the state just before it. */
  epoch: z.number().int().nonnegative().optional(),
  epochOffset: z.number().int().nonnegative().optional(),
  epochEventId: z.string().optional(),
  snapshot: ResumeSnapshot.optional(),
  /** ISO time after which the session's rewind-only data may be collected; written by GC (event-log "Blob store"). */
  rewindAvailableUntil: z.string().optional(),
});
export type SessionMeta = z.infer<typeof SessionMeta>;

const TITLE_CHARS = 60;
const UserText = z.object({ text: z.string() });

export function emptyMeta(id: string): SessionMeta {
  return { id, title: "", created: "", updated: "", turns: 0, lastId: "", bytes: 0 };
}

export function foldMeta(meta: SessionMeta, e: Pick<EventEnvelope, "id" | "ts" | "type" | "data">): SessionMeta {
  const next = { ...meta, created: meta.created || e.ts, updated: e.ts, lastId: e.id };
  if (e.type === "turn.end") next.turns += 1;
  if (e.type === "user.message" && meta.title === "") {
    const parsed = UserText.safeParse(e.data);
    if (parsed.success) next.title = parsed.data.text.slice(0, TITLE_CHARS).trimEnd();
  }
  return next;
}

/** `/rewind` shows "expired" for a session whose rewind data GC may have collected; resuming it still works. */
export function rewindExpired(meta: Pick<SessionMeta, "rewindAvailableUntil">, now: number): boolean {
  return meta.rewindAvailableUntil !== undefined && Date.parse(meta.rewindAvailableUntil) < now;
}
