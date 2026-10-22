// A fork's own copy of the session's plan file (tools §11.1 "A fork gets its own copy"; QUESTIONS Q85).
import { constants, copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { canonicalizePath, isErrno, isWithin, lexicalPath, PathRefused } from "../../platform/index.ts";
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

function inProject(loc: SessionLocation, path: string): boolean {
  const canonical = canonicalizePath(path, loc.projectRoot, loc.os);
  const root = canonicalizePath(loc.projectRoot, loc.projectRoot, loc.os);
  return (
    isWithin(lexicalPath(path, loc.projectRoot, loc.os), loc.projectRoot, loc.os) &&
    isWithin(canonical, root, loc.os) &&
    !relative(root, canonical)
      .split(sep)
      .some((part) => part.toLowerCase() === ".git")
  );
}

/**
 * The directory `plan.directory` names, when it is inside the project (links followed) and not in `.git`; anything else
 * would let a plan file, which plan mode may write without asking, land where no other write is allowed (tools §11.1).
 */
export function projectPlanDir(loc: SessionLocation, planDirectory: string): string | undefined {
  const dir = join(loc.projectRoot, planDirectory);
  try {
    return inProject(loc, dir) ? dir : undefined;
  } catch (err) {
    if (err instanceof PathRefused) return undefined;
    throw err;
  }
}

/**
 * Whether a plan file named by the log (resume, fork) is one this session could have made: in its own plan folder, or
 * in `within` (default: anywhere in the project) under the same rules as `projectPlanDir`. The log is untrusted input.
 */
export function planFileAllowed(loc: SessionLocation, file: string, within?: string): boolean {
  try {
    if (isWithin(lexicalPath(file, loc.projectRoot, loc.os), planDir(loc), loc.os)) return true;
    const root = within ?? loc.projectRoot;
    return isWithin(lexicalPath(file, loc.projectRoot, loc.os), root, loc.os) && inProject(loc, file);
  } catch (err) {
    if (err instanceof PathRefused) return false;
    throw err;
  }
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
  if (!planFileAllowed(parent, parentPlan))
    return eventLine(
      "settings.change",
      { session: child.session, epoch },
      { key: PLAN_FILE_KEY, old: parentPlan, new: null, source: "fork" },
      deps,
    );
  const target = isWithin(lexicalPath(parentPlan, parent.projectRoot, parent.os), planDir(parent), parent.os)
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
