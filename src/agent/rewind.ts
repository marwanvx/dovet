// Restoring files for /rewind (checkpoints "Rewind"): the logged result, the note to the model, the forgotten reads.
import { CheckpointData, type EventEnvelope, type EventType } from "../schema/index.ts";
import type { CheckpointService, RewindResult } from "../store/index.ts";
import type { ReadStateStore } from "../tools/index.ts";

export const restoreNote = (turn: number): string =>
  `The user restored files to their state before turn ${turn}. Re-read files before editing them.`;

export interface RewindDeps {
  checkpoints: CheckpointService;
  readState: ReadStateStore;
  push(type: Extract<EventType, "file.change" | "system.injected">, data: unknown): void;
}

/**
 * Restores every path changed in turns >= `turn` to its state at the first checkpoint from that turn on (a turn that
 * changed nothing has none of its own), logs each change as a rewind, adds the note and clears read-state for the
 * paths it changed. `onConflict` is the user's answer to the conflict prompt.
 */
export async function restoreFiles(
  deps: RewindDeps,
  events: readonly EventEnvelope[],
  turn: number,
  onConflict: "overwrite" | "skip",
): Promise<RewindResult> {
  const turns = events
    .filter((e) => e.type === "checkpoint")
    .map((e) => CheckpointData.parse(e.data).turn)
    .filter((t) => t >= turn);
  if (turns.length === 0) return { written: 0, deleted: 0, skipped: [], failed: [], changes: [] };
  const result = await deps.checkpoints.restore(events, `c${Math.min(...turns)}`, onConflict);
  for (const c of result.changes) {
    deps.push("file.change", {
      path: c.path,
      op: c.op,
      added: 0,
      removed: 0,
      before: c.before,
      after: c.after,
      via: "rewind",
    });
    deps.readState.delete(c.path);
  }
  if (result.changes.length > 0)
    deps.push("system.injected", { text: restoreNote(turn), reason: "restore-note", delivery: "reminder-block" });
  return result;
}
