// A fork's own copy of the session's plan file (tools §11.1 "A fork gets its own copy"; QUESTIONS Q85).
import { constants, copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { isErrno, isWithin } from "../../platform/index.ts";
import type { EventEnvelope } from "../../schema/index.ts";
import { eventLine } from "./lines.ts";
import { planDir, type SessionLocation } from "./paths.ts";

export const PLAN_FILE_KEY = "planFile";

/** The plan file a `settings.change` names: a path, `null` once cleared, `undefined` for any other event. */
export function planFileOf(e: Pick<EventEnvelope, "type" | "data">): string | null | undefined {
  if (e.type !== "settings.change") return undefined;
  const d = e.data as { key?: unknown; new?: unknown };
  if (d.key !== PLAN_FILE_KEY) return undefined;
  return typeof d.new === "string" ? d.new : null;
}

/**
 * Copies `parentPlan` for the fork and returns the line that points the fork at the copy. A plan in the parent's own
 * folder goes to the fork's; one under the project (`plan.directory`) is copied beside it under a name made unique by
 * the fork's id. A plan never written has nothing to copy and still gets its own path.
 */
export async function forkPlanLine(
  parent: SessionLocation,
  child: SessionLocation,
  parentPlan: string,
  epoch: number,
  deps: { ids: { ulid(): string }; clock: { now(): number } },
): Promise<string> {
  const target = isWithin(parentPlan, planDir(parent), parent.os)
    ? join(planDir(child), basename(parentPlan))
    : join(
        dirname(parentPlan),
        `${basename(parentPlan, extname(parentPlan))}-${child.session.slice(-4).toLowerCase()}${extname(parentPlan)}`,
      );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(parentPlan, target, constants.COPYFILE_EXCL).catch((err: unknown) => {
    if (!isErrno(err, "ENOENT")) throw err;
  });
  return eventLine(
    "settings.change",
    { session: child.session, epoch },
    { key: PLAN_FILE_KEY, old: parentPlan, new: target, source: "fork" },
    deps,
  );
}
