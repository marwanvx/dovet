import { join, posix, win32 } from "node:path";
import { type Os, pathKey } from "../../platform/index.ts";

export type SessionLocation = { data: string; projectRoot: string; os: Os; session: string };
export type ProjectLocation = Omit<SessionLocation, "session">;

/** `<basename>-<first 16 hex of SHA-256 of the canonical root>` (event-log "Locations"). */
export function projectId(projectRoot: string, os: Os): string {
  const hash = new Bun.CryptoHasher("sha256").update(pathKey(projectRoot, os)).digest("hex").slice(0, 16);
  return `${(os === "win32" ? win32 : posix).basename(projectRoot)}-${hash}`;
}

export function sessionsDir(loc: ProjectLocation): string {
  return join(loc.data, "projects", projectId(loc.projectRoot, loc.os), "sessions");
}

export function sessionPaths(loc: SessionLocation): { dir: string; log: string; lock: string; meta: string } {
  const dir = sessionsDir(loc);
  const base = join(dir, loc.session);
  return { dir, log: `${base}.jsonl`, lock: `${base}.lock`, meta: `${base}.meta.json` };
}

/** Where a session's own plan files live: `<data>/projects/<project>/plans/<session>` (tools §11.1; QUESTIONS Q85). */
export function planDir(loc: SessionLocation): string {
  return join(loc.data, "projects", projectId(loc.projectRoot, loc.os), "plans", loc.session);
}
