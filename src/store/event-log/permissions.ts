import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isErrno } from "../../platform/index.ts";
import { type ProjectLocation, sessionsDir } from "./paths.ts";

/** Startup check (event-log "Writer rules" 6): `<data>`, its stores and this project's session files must be user-only. */
export async function checkDataPermissions(loc: ProjectLocation): Promise<string[]> {
  if (loc.os === "win32") return [];
  const sessions = sessionsDir(loc);
  const files = await readdir(sessions).then(
    (names) => names.sort().map((n) => join(sessions, n)),
    (err: unknown) => (isErrno(err, "ENOENT") ? [] : Promise.reject(err)),
  );
  const warnings: string[] = [];
  for (const path of [loc.data, join(loc.data, "projects"), join(loc.data, "blobs"), sessions, ...files]) {
    const mode = await stat(path).then(
      (s) => s.mode & 0o777,
      (err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)),
    );
    if (mode === undefined || (mode & 0o077) === 0) continue;
    warnings.push(
      `${path} can be read by other users (mode ${mode.toString(8)}); it holds code and command output. Fix: chmod go-rwx ${path}`,
    );
  }
  return warnings;
}
