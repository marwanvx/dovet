// Garbage collection of the data directory (event-log "Blob store", "Disk use"; checkpoints "GC").
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hardenedGitEnv, isErrno } from "../../platform/index.ts";
import { writePrivateAtomic } from "../event-log/files.ts";
import { emptyDir, lines, runGit } from "../snapshots/git.ts";
import { loadStatCache } from "../snapshots/stat-cache.ts";
import { inventory, listDir, mtimeOf, removeSession, type SessionFiles, STALE_LOCK_MS } from "./layout.ts";
import { traceLog } from "./refs.ts";

const DAY_MS = 86_400_000;
const HEARTBEAT_MS = 30_000;
const GRACE_MS = 60 * 60_000;
const BLOB_NAME = /^[0-9a-f]{64}$/;

export type GcSettings = { days: number; deleteSessions: boolean; outputsDays: number };

export type GcInput = {
  data: string;
  now: number;
  settings: GcSettings;
  /** The caller's environment for git (`GIT_*` is dropped). */
  env: Readonly<Record<string, string | undefined>>;
  /** Blobs and snapshot objects younger than this are never removed: their event may not be logged yet. */
  graceMs?: number;
  signal?: AbortSignal;
};

export type GcReport = {
  skipped?: string;
  blobsRemoved: number;
  bytesFreed: number;
  offloadRemoved: number;
  sessionsDeleted: string[];
  /** Projects whose snapshot store was left alone because a session was writing. */
  projectsSkipped: string[];
  problems: string[];
};

/** Exclusive-create; a lock without a heartbeat for 2 minutes is taken over (event-log "Blob store": the GC lock). */
async function takeLock(lock: string, now: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(lock, JSON.stringify({ started: now }), { flag: "wx", mode: 0o600 });
      return true;
    } catch (err) {
      if (!isErrno(err, "EEXIST")) throw err;
    }
    const beat = await mtimeOf(lock);
    if (beat !== undefined && now - beat <= STALE_LOCK_MS) return false;
    const stale = `${lock}.${crypto.randomUUID()}.stale`;
    const moved = await rename(lock, stale).then(
      () => true,
      (err: unknown) => (isErrno(err, "ENOENT") ? false : Promise.reject(err)),
    );
    if (moved) await rm(stale, { force: true });
  }
  return false;
}

export async function runGc(input: GcInput): Promise<GcReport> {
  const report: GcReport = {
    blobsRemoved: 0,
    bytesFreed: 0,
    offloadRemoved: 0,
    sessionsDeleted: [],
    projectsSkipped: [],
    problems: [],
  };
  if ((await mtimeOf(input.data)) === undefined) return { ...report, skipped: "no data directory" };
  const lock = join(input.data, "gc.lock");
  if (!(await takeLock(lock, input.now))) return { ...report, skipped: "another GC is already running" };
  const beat = setInterval(() => {
    const t = new Date();
    utimes(lock, t, t).catch((err: unknown) => {
      report.problems.push(`GC lock heartbeat failed (${err instanceof Error ? err.message : String(err)})`);
    });
  }, HEARTBEAT_MS);
  beat.unref();
  try {
    if (!(await collect(input, report))) report.skipped = "stopped before finishing";
  } finally {
    clearInterval(beat);
    await rm(lock, { force: true });
  }
  return report;
}

async function expireFiles(dir: string, olderThan: number, report: GcReport): Promise<void> {
  for (const name of await listDir(dir)) {
    const path = join(dir, name);
    const modified = await mtimeOf(path);
    if (modified === undefined || modified >= olderThan) continue;
    await rm(path, { recursive: true, force: true });
    report.offloadRemoved += 1;
  }
}

/** Records when a session's rewind data expires in its sidecar (event-log "Blob store"); a missing sidecar is rebuilt later and skipped here. */
async function recordExpiry(s: SessionFiles, until: number): Promise<void> {
  const path = join(s.dir, `${s.id}.meta.json`);
  const text = await readFile(path, "utf8").catch((err: unknown) =>
    isErrno(err, "ENOENT") ? undefined : Promise.reject(err),
  );
  if (text === undefined) return;
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return;
    throw err;
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return;
  await writePrivateAtomic(
    path,
    `${JSON.stringify({ ...meta, rewindAvailableUntil: new Date(until).toISOString() })}\n`,
  );
}

/** False when the run was stopped. */
async function collect(input: GcInput, report: GcReport): Promise<boolean> {
  const { data, now, settings } = input;
  const grace = input.graceMs ?? GRACE_MS;
  const retention = settings.days * DAY_MS;
  const stopped = (): boolean => input.signal?.aborted === true;
  if (stopped()) return false;

  const sessions: SessionFiles[] = [];
  for (const s of await inventory(data, now)) {
    if (settings.deleteSessions && !s.active && now - s.modified > retention) {
      await removeSession(s);
      report.sessionsDeleted.push(s.id);
    } else sessions.push(s);
  }

  const expired = new Set<SessionFiles>();
  for (const s of sessions) {
    if (s.active) continue;
    await expireFiles(join(s.dir, s.id, "outputs"), now - settings.outputsDays * DAY_MS, report);
    await expireFiles(join(s.dir, s.id, "requests"), now - settings.outputsDays * DAY_MS, report);
    await recordExpiry(s, s.modified + retention);
    if (now > s.modified + retention) {
      expired.add(s);
      for (const ext of ["snap.stat", "snap.index"]) await rm(join(s.dir, `${s.id}.${ext}`), { force: true });
    }
  }
  if (stopped()) return false;

  const keep = new Set<string>();
  const trees = new Map<string, Set<string>>();
  for (const s of sessions) {
    const refs = await traceLog(s.log);
    for (const sha of refs.essential) keep.add(sha);
    if (expired.has(s)) continue;
    for (const sha of refs.rewind) keep.add(sha);
    const set = trees.get(s.project) ?? new Set();
    for (const t of refs.trees) set.add(t);
    trees.set(s.project, set);
  }
  if (stopped()) return false;

  await removeBlobs(join(data, "blobs"), keep, now - grace, now, report, stopped);

  for (const project of await listDir(join(data, "projects"))) {
    if (stopped()) return false;
    const mine = sessions.filter((s) => s.project === project);
    if (mine.some((s) => s.active)) {
      report.projectsSkipped.push(project);
      continue;
    }
    const projectDir = join(data, "projects", project);
    try {
      await pruneStore(input, projectDir, trees.get(project) ?? new Set(), mine);
    } catch (err) {
      report.problems.push(
        `${project}: snapshot objects not collected (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return !stopped();
}

async function removeBlobs(
  root: string,
  keep: ReadonlySet<string>,
  youngerThan: number,
  now: number,
  report: GcReport,
  stopped: () => boolean,
): Promise<void> {
  for (const shard of await listDir(root)) {
    for (const name of await listDir(join(root, shard))) {
      if (stopped()) return;
      const path = join(root, shard, name);
      const info = await stat(path).catch((err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)));
      if (info === undefined) continue;
      const blob = BLOB_NAME.test(name);
      // A temp file left by a crashed write; a live write finishes within moments.
      const leftover = name.endsWith(".tmp") && now - info.mtimeMs > DAY_MS;
      if (!(blob && !keep.has(name) && info.mtimeMs < youngerThan) && !leftover) continue;
      await rm(path, { force: true });
      report.blobsRemoved += blob ? 1 : 0;
      report.bytesFreed += info.size;
    }
  }
}

/**
 * Drops the private store's objects no retained checkpoint or session cache needs (checkpoints "GC"): the roots become
 * refs of a throwaway repository, then unreachable packed objects are dropped and unreachable loose ones pruned.
 */
async function pruneStore(
  input: GcInput,
  projectDir: string,
  trees: ReadonlySet<string>,
  sessions: readonly SessionFiles[],
): Promise<void> {
  const objects = join(projectDir, "objects");
  if ((await mtimeOf(objects)) === undefined) return;
  const roots = new Set(trees);
  for (const s of sessions) {
    for (const entry of loadStatCache(join(s.dir, `${s.id}.snap.stat`)).values()) roots.add(entry.blob);
  }
  const env = hardenedGitEnv(input.env);
  const scratch = await mkdtemp(join(projectDir, "gc-"));
  try {
    const ctx = { cwd: scratch, env, hooksDir: emptyDir(join(projectDir, "empty-hooks")) };
    const gitEnv = { GIT_DIR: join(scratch, "git"), GIT_OBJECT_DIRECTORY: objects };
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    await runGit(ctx, ["init", "--bare", "-q", gitEnv.GIT_DIR]);
    // Even with nothing retained, a ref to the empty tree keeps `repack` from being a no-op.
    const empty = lines(await runGit(ctx, ["mktree"], { env: gitEnv, input: encode("") }))[0];
    if (empty !== undefined) roots.add(empty);
    const checked = await runGit(ctx, ["cat-file", "--batch-check"], {
      env: gitEnv,
      input: encode(`${[...roots].join("\n")}\n`),
    });
    const present = lines(checked).filter((l) => !l.endsWith(" missing"));
    const refs = present.map((l, i) => `create refs/dovet-gc/${i} ${l.split(" ")[0]}\n`).join("");
    await runGit(ctx, ["update-ref", "--stdin"], { env: gitEnv, input: encode(refs) });
    const when =
      (input.graceMs ?? GRACE_MS) === 0 ? "now" : `${Math.ceil((input.graceMs ?? GRACE_MS) / 1000)}.seconds.ago`;
    await runGit(ctx, ["repack", "-A", "-d", "-q", `--unpack-unreachable=${when}`], { env: gitEnv });
    await runGit(ctx, ["prune", `--expire=${when}`], { env: gitEnv });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
