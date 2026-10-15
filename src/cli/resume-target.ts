// Resolving --resume/--continue to a session id, plus ephemeral data dirs (event-log "Resume").
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ulid } from "../schema/index.ts";
import { listSessions, type ProjectLocation } from "../store/index.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Pure time-ordered ULID (matches `Ulid`); randomness comes from the caller. */
export function makeUlid(nowMs: number, rand: Uint8Array): Ulid {
  let time = Math.floor(nowMs);
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD.charAt(time % 32) + head;
    time = Math.floor(time / 32);
  }
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD.charAt((rand[i] ?? 0) % 32);
  return `${head}${tail}`;
}

/** `--resume [id]` (exact or unique prefix) or `--continue`/bare `--resume` (latest) (event-log "Resume"). */
export async function resolveResumeTarget(
  loc: ProjectLocation,
  arg: string | undefined,
  continued: boolean,
): Promise<{ id: string } | { error: string }> {
  const sessions = await listSessions(loc);
  if (sessions.length === 0) return { error: "no saved sessions for this project" };
  if (arg !== undefined) {
    if (sessions.some((s) => s.id === arg)) return { id: arg };
    const prefixed = sessions.filter((s) => s.id.startsWith(arg));
    if (prefixed.length === 1 && prefixed[0] !== undefined) return { id: prefixed[0].id };
    if (prefixed.length === 0) return { error: `no session matches "${arg}"` };
    return { error: `"${arg}" matches ${prefixed.length} sessions; give a longer id` };
  }
  if (continued) {
    const latest = sessions[sessions.length - 1];
    if (latest !== undefined) return { id: latest.id };
  }
  return { error: "no session given; pass --resume <id> or --continue" };
}

/** `--no-session-persistence` writes the log to a temp directory removed at exit (event-log "Resume"). */
export async function ephemeralDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dovet-ephemeral-"));
}
