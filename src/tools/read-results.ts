// The read-results index (tools §0): which Reads are still in this epoch's transcript, for re-read dedup (§1.5).
import { z } from "zod";
import { type EventEnvelope, ToolCallData, ToolResultData, TurnEndData } from "../schema/index.ts";

export type ReadResultKey = {
  file_path: string;
  offset?: number | undefined;
  limit?: number | undefined;
  pages?: string | undefined;
};
export type ReadResultEntry = { sha256: string; turn: number; dedup: boolean };

export interface ReadResultsIndex {
  lookup(key: ReadResultKey): ReadResultEntry | undefined;
}

export const DEDUP_PREFIX = "File unchanged since your Read in turn ";

export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const keyOf = (k: ReadResultKey): string =>
  JSON.stringify([k.file_path, k.offset ?? null, k.limit ?? null, k.pages ?? null]);

const CallInput = z.object({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  pages: z.string().optional(),
});

function keyFromInput(input: unknown): string | undefined {
  const parsed = CallInput.safeParse(input);
  return parsed.success ? keyOf({ ...parsed.data }) : undefined;
}

/** Derived from `tool.call`/`tool.result` events of one epoch; a fork's log lacks the Reads of the rewound branch, and cancelled turns never reached the model. */
export function buildReadResultsIndex(events: readonly EventEnvelope[], epoch: number): ReadResultsIndex {
  const cancelled = new Set<number>();
  for (const e of events) {
    if (e.type === "turn.end" && e.turn !== null && TurnEndData.parse(e.data).reason === "cancelled")
      cancelled.add(e.turn);
  }
  const pending = new Map<string, string>();
  const latest = new Map<string, ReadResultEntry>();
  for (const e of events) {
    if (e.epoch !== epoch || e.turn === null || cancelled.has(e.turn)) continue;
    if (e.type === "tool.call") {
      const call = ToolCallData.parse(e.data);
      const key = call.name === "Read" ? keyFromInput(call.input) : undefined;
      if (key !== undefined) pending.set(call.callId, key);
    } else if (e.type === "tool.result") {
      const result = ToolResultData.parse(e.data);
      const key = pending.get(result.callId);
      if (key === undefined || result.status !== "ok") continue;
      latest.set(key, {
        sha256: sha256Hex(result.output),
        turn: e.turn,
        dedup: result.output.startsWith(DEDUP_PREFIX),
      });
    }
  }
  return { lookup: (key) => latest.get(keyOf(key)) };
}
