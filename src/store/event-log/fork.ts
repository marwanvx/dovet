// Fork at a turn for /rewind (checkpoints "Rewind"): a new session whose log copies the events before that turn's message.
import { mkdir, open, rm } from "node:fs/promises";
import { UserMessageData } from "../../schema/index.ts";
import { createBlobStore } from "../blobs/index.ts";
import { type SessionLocation, sessionPaths } from "./paths.ts";
import { forkPlanLine, planFileOf } from "./plan.ts";
import { resolveBlobs } from "./reader.ts";
import { eventLines, sessionForkLine } from "./resume.ts";

/**
 * Copies every event before turn `turn`'s `user.message` into the new session `session` and ends it with
 * `session.fork`; the original is only read. The checkpoint and file events come along, and they name the project's
 * snapshot objects and the blob store, which the fork shares with its parent instead of copying: nothing in the
 * parent's own files is needed to rewind the fork. `message` is what goes back into the input box.
 */
export async function forkAtTurn(
  loc: SessionLocation,
  session: string,
  turn: number,
  deps: { ids: { ulid(): string }; clock: { now(): number }; projectPlans?: string },
): Promise<{ loc: SessionLocation; copied: number; parentEvent: string; message: UserMessageData }> {
  const next: SessionLocation = { ...loc, session };
  const paths = sessionPaths(next);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const out = await open(paths.log, "wx", 0o600);
  let copied = 0;
  let parentEvent = "";
  let epoch = 0;
  let plan: string | null = null;
  let message: UserMessageData | undefined;
  const events = eventLines(sessionPaths(loc).log);
  try {
    for await (const { line, event: e } of events) {
      if (e.type === "user.message" && e.turn === turn) {
        message = UserMessageData.parse(await resolveBlobs(e.data, createBlobStore(loc.data)));
        break;
      }
      await out.appendFile(`${line}\n`);
      copied++;
      parentEvent = e.id;
      epoch = Math.max(epoch, e.epoch);
      const named = planFileOf(e);
      if (named !== undefined) plan = named;
    }
    if (message !== undefined) {
      await out.appendFile(sessionForkLine({ session, epoch, parent: loc.session, parentEvent }, deps));
      if (plan !== null) await out.appendFile(await forkPlanLine(loc, next, plan, epoch, deps, deps.projectPlans));
      await out.sync();
    }
  } finally {
    await events.return?.(undefined);
    await out.close();
  }
  if (message === undefined) {
    await rm(paths.log, { force: true });
    throw new Error(`session ${loc.session} has no turn ${turn} to fork at`);
  }
  return { loc: next, copied, parentEvent, message };
}
