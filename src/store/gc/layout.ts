// The session files under `<data>/projects/<project>/sessions` (event-log "Locations").
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isErrno } from "../../platform/index.ts";

/** A writer's lock without a heartbeat for this long is stale (event-log "Writer rules" 1). */
export const STALE_LOCK_MS = 2 * 60_000;

export type SessionFiles = {
  project: string;
  id: string;
  /** `<data>/projects/<project>/sessions` */
  dir: string;
  log: string;
  /** Last append to the log: when the session was last used. */
  modified: number;
  /** A writer's heartbeat is fresh: nothing may be collected under it. */
  active: boolean;
};

const SIDE_FILES = ["meta.json", "lock", "snap.index", "snap.stat"];

export async function listDir(path: string): Promise<string[]> {
  return readdir(path).catch((err: unknown) => (isErrno(err, "ENOENT", "ENOTDIR") ? [] : Promise.reject(err)));
}

export async function mtimeOf(path: string): Promise<number | undefined> {
  return stat(path).then(
    (s) => s.mtimeMs,
    (err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)),
  );
}

/** Every project's sessions, oldest first. */
export async function inventory(data: string, now: number): Promise<SessionFiles[]> {
  const out: SessionFiles[] = [];
  for (const project of (await listDir(join(data, "projects"))).sort()) {
    const dir = join(data, "projects", project, "sessions");
    for (const name of (await listDir(dir)).filter((n) => n.endsWith(".jsonl")).sort()) {
      const id = name.slice(0, -".jsonl".length);
      const log = join(dir, name);
      const modified = await mtimeOf(log);
      if (modified === undefined) continue;
      const beat = await mtimeOf(join(dir, `${id}.lock`));
      out.push({ project, id, dir, log, modified, active: beat !== undefined && now - beat <= STALE_LOCK_MS });
    }
  }
  return out.sort((a, b) => a.modified - b.modified);
}

export async function dirBytes(path: string): Promise<number> {
  const info = await stat(path).catch((err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)));
  if (info === undefined) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await listDir(path)) total += await dirBytes(join(path, name));
  return total;
}

export async function sessionBytes(s: SessionFiles): Promise<number> {
  let total = await dirBytes(s.log);
  for (const ext of SIDE_FILES) total += await dirBytes(join(s.dir, `${s.id}.${ext}`));
  return total + (await dirBytes(join(s.dir, s.id)));
}

/** Removes the log and everything that belongs to it, log last so a crash leaves a session that is still listed. */
export async function removeSession(s: SessionFiles): Promise<void> {
  await rm(join(s.dir, s.id), { recursive: true, force: true });
  for (const ext of SIDE_FILES) await rm(join(s.dir, `${s.id}.${ext}`), { force: true });
  await rm(s.log, { force: true });
}
