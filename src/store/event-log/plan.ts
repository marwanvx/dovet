// A fork's own copy of the session's plan file (tools §11.1 "A fork gets its own copy"; QUESTIONS Q85).
import { lstatSync } from "node:fs";
import { constants, copyFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { canonicalizePath, isErrno, isWithin, lexicalPath, PathRefused, pathKey } from "../../platform/index.ts";
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
 * The plan file as the tools see it: Edit and Write offer the policy the written and the real path, and plan mode
 * allows the edit only when both are the plan file, so the file is named by its real path (short names and links
 * resolved) from the start.
 */
export function canonicalPlanFile(loc: SessionLocation, file: string): string {
  try {
    return canonicalizePath(file, loc.projectRoot, loc.os);
  } catch (err) {
    if (err instanceof PathRefused) return file;
    throw err;
  }
}

/** Plan files are `<slug>-<4 characters>.md` (tools §11.1), which no instruction, settings or environment file is. */
const PLAN_FILE_NAME = /-[0-9a-z]{4}\.md$/i;

function inProject(loc: SessionLocation, path: string): boolean {
  const canonical = canonicalizePath(path, loc.projectRoot, loc.os);
  const root = canonicalizePath(loc.projectRoot, loc.projectRoot, loc.os);
  return (
    isWithin(lexicalPath(path, loc.projectRoot, loc.os), loc.projectRoot, loc.os) &&
    isWithin(canonical, root, loc.os) &&
    !relative(root, canonical)
      .split(sep)
      .some((part) => part.startsWith("."))
  );
}

/**
 * The directory `plan.directory` names, when it is inside the project (links followed) and no part of it starts with a
 * dot: plan mode may write the plan file without asking and no path check runs on it, so it must not be able to reach
 * `.git`, `.dovet`, `.claude`, `.env*` or any other place the policy protects (tools §11.1).
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
 * directly in `projectPlans` (what `projectPlanDir` gave) under a plan file's name. The log is untrusted input.
 */
export function planFileAllowed(loc: SessionLocation, file: string, projectPlans?: string): boolean {
  try {
    const lexical = lexicalPath(file, loc.projectRoot, loc.os);
    if (isLink(lexical)) return false;
    const real = canonicalPlanFile(loc, file);
    if (isWithin(lexical, planDir(loc), loc.os) || isWithin(real, canonicalPlanFile(loc, planDir(loc)), loc.os))
      return true;
    return (
      projectPlans !== undefined &&
      PLAN_FILE_NAME.test(real) &&
      pathKey(dirname(real), loc.os) === pathKey(canonicalPlanFile(loc, projectPlans), loc.os) &&
      inProject(loc, file)
    );
  } catch (err) {
    if (err instanceof PathRefused) return false;
    throw err;
  }
}

/** A link with a plan file's name would send a read or copy to whatever it points at (a key, a settings file). */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return false;
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
  projectPlans?: string,
): Promise<string> {
  if (!planFileAllowed(parent, parentPlan, projectPlans))
    return eventLine(
      "settings.change",
      { session: child.session, epoch },
      { key: PLAN_FILE_KEY, old: parentPlan, new: null, source: "fork" },
      deps,
    );
  const target = canonicalPlanFile(
    child,
    isWithin(lexicalPath(parentPlan, parent.projectRoot, parent.os), planDir(parent), parent.os)
      ? join(planDir(child), basename(parentPlan))
      : join(
          dirname(parentPlan),
          `${basename(parentPlan, extname(parentPlan))}-${child.session.slice(-4).toLowerCase()}${extname(parentPlan)}`,
        ),
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
