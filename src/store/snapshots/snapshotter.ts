// Git tree snapshots (docs/specs/checkpoints.md "Git tree snapshots", ADR-19): a tree object per checkpoint, built in a
// private object directory with a private index, from the raw bytes on disk. Nothing is written into the user's `.git`
// (not even a timestamp: the private store holds every blob itself and no alternate is configured), and `git add` /
// `checkout` (which run clean/smudge/process filters) are never used.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Env, emptyDir, type GitContext, lines, runGit, scrubbedEnv, splitNul } from "./git.ts";
import { loadStatCache, type StatCache, saveStatCache } from "./stat-cache.ts";

const UNTRACKED_LIMIT = 2n * 1024n * 1024n;
const FILE_LIMIT = 50_000_000n;
/** A file modified this recently may change again within the filesystem's timestamp granularity. */
const RACY_NS = 2_000_000_000n;
/** Nested repositories inside nested repositories; deeper ones are not walked. */
const MAX_NESTING = 10;
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface SnapshotterOptions {
  /** Any directory inside the repository; snapshots cover the repository's top level. */
  workspace: string;
  /** `<data>/projects/<id>`: holds `objects/` (shared by sessions) and `sessions/` (one index + stat cache each). */
  projectDir: string;
  session: string;
  /** The caller's environment (only `cli/main.ts` reads `process.env`); `GIT_*` variables are dropped. */
  env: Env;
  /** The caller's `process.platform`: Windows has no execute bit. */
  platform: NodeJS.Platform;
}

export type SkipReason = "too-large" | "gitlink" | "unsupported" | "link" | "blocked";
export interface SkippedPath {
  path: string;
  reason: SkipReason;
}

export interface SnapshotResult {
  /** Tree object id in the private object store. */
  tree: string;
  /** Files whose bytes were read and hashed this time (the rest came from the stat cache). */
  hashed: number;
  /** Paths left out of the tree; the receipt lists them as not restorable, and `restore` must be given them. */
  skipped: SkippedPath[];
}

export interface RestoreResult {
  written: number;
  deleted: number;
  /** Paths not touched because writing could go through a link, or something is in the way. */
  skipped: SkippedPath[];
}

export interface Snapshotter {
  snapshot(): Promise<SnapshotResult>;
  /**
   * Makes the workspace match `tree`: rewrites changed files, deletes files created since. `checkpointSkipped` is the
   * `skipped` list of the snapshot that made `tree`: those paths existed then but are not in the tree, so they are
   * never deleted.
   */
  restore(tree: string, checkpointSkipped: readonly SkippedPath[]): Promise<RestoreResult>;
}

interface Listed {
  path: string;
  tracked: boolean;
  /** Commit id of a submodule, from the user's index. */
  gitlink?: string;
}

interface Planned {
  path: string;
  mode: string;
  size: bigint;
  mtimeNs: bigint;
  ino: bigint;
  /** What to hash: the file itself, or for a symlink a scratch file holding the link target. */
  source: string;
  blob?: string;
}

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export async function openSnapshotter(options: SnapshotterOptions): Promise<Snapshotter> {
  const posix = options.platform !== "win32";
  const env = scrubbedEnv(options.env);
  const objectsDir = emptyDir(join(options.projectDir, "objects"));
  const sessionsDir = emptyDir(join(options.projectDir, "sessions"));
  const scratchDir = emptyDir(join(options.projectDir, "scratch"));
  const hooksDir = emptyDir(join(options.projectDir, "empty-hooks"));
  const indexPath = join(sessionsDir, `${options.session}.snap.index`);
  const statPath = join(sessionsDir, `${options.session}.snap.stat`);

  const top = lines(
    await runGit({ cwd: options.workspace, env, hooksDir }, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
  )[0];
  if (top === undefined) throw new Error(`${options.workspace} is not in a git repository`);
  const root = resolve(top);
  const ctx: GitContext = { cwd: root, env, hooksDir };
  // Only the private store is configured: every blob a tree needs is written there, so a checkpoint stays restorable
  // however the user's repository is pruned, and git never touches the user's objects (it would freshen their
  // timestamps if they were an alternate).
  const privateEnv = { GIT_INDEX_FILE: indexPath, GIT_OBJECT_DIRECTORY: objectsDir };

  // A new session starts from the most recent session's stat cache, so its first snapshot hashes only what changed.
  if (!existsSync(statPath)) seedStatCache(sessionsDir, statPath);
  let cache = loadStatCache(statPath);

  /** Files of the repository at `dir` (relative to the top level; "" for the top), nested repositories included. */
  async function list(dir: string, depth: number): Promise<{ files: Listed[]; skipped: SkippedPath[] }> {
    const here: GitContext = { ...ctx, cwd: join(root, dir) };
    const files: Listed[] = [];
    const skipped: SkippedPath[] = [];
    const seen = new Set<string>();
    const found: Listed[] = [];
    if (dir === "") {
      // The user's real index, read-only: no GIT_INDEX_FILE override, no filters, .gitignore respected.
      for (const record of splitNul(await runGit(here, ["ls-files", "-z", "--cached", "--stage"]))) {
        const m = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(record);
        if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined)
          throw new Error("unexpected ls-files output");
        found.push(m[1] === "160000" ? { path: m[3], tracked: true, gitlink: m[2] } : { path: m[3], tracked: true });
      }
      for (const path of splitNul(await runGit(here, ["ls-files", "-z", "--others", "--exclude-standard"]))) {
        found.push({ path, tracked: false });
      }
    } else {
      // A nested repository counts as untracked content of its parent; its own `.git` is never listed.
      const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
      for (const path of splitNul(await runGit(here, args))) found.push({ path, tracked: false });
    }
    for (const item of found) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      const path = dir === "" ? item.path : `${dir}/${item.path}`;
      if (item.path.endsWith("/")) {
        if (depth >= MAX_NESTING) skipped.push({ path, reason: "unsupported" });
        else {
          const inner = await list(path.slice(0, -1), depth + 1);
          files.push(...inner.files);
          skipped.push(...inner.skipped);
        }
      } else files.push({ ...item, path });
    }
    return { files, skipped };
  }

  async function snapshot(): Promise<SnapshotResult> {
    const startNs = BigInt(Date.now()) * 1_000_000n;
    const listing = await list("", 0);
    const skipped: SkippedPath[] = listing.skipped;
    const planned: Planned[] = [];

    for (const { path, tracked, gitlink } of listing.files) {
      if (path.includes("\n")) {
        skipped.push({ path, reason: "unsupported" }); // `--stdin-paths` is newline-separated
        continue;
      }
      const full = join(root, path);
      const st = lstatSync(full, { bigint: true, throwIfNoEntry: false });
      if (st === undefined) continue; // tracked, but deleted on disk
      const base = { path, size: st.size, mtimeNs: st.mtimeNs, ino: st.ino, source: full };
      if (st.isDirectory()) {
        // A submodule: recorded as a gitlink (its commit id), not restorable.
        if (gitlink !== undefined) planned.push({ ...base, mode: "160000", blob: gitlink });
        skipped.push({ path, reason: "gitlink" });
      } else if (st.isSymbolicLink()) {
        planned.push({ ...base, mode: "120000" });
      } else if (st.isFile()) {
        if (st.size > FILE_LIMIT || (!tracked && st.size > UNTRACKED_LIMIT)) {
          skipped.push({ path, reason: "too-large" });
          continue;
        }
        const exec = posix && (st.mode & 0o111n) !== 0n;
        planned.push({ ...base, mode: exec ? "100755" : "100644" });
      } else {
        skipped.push({ path, reason: "unsupported" });
      }
    }

    // Unchanged files take their blob id from the stat cache; the rest are hashed in one git process.
    const toHash: Planned[] = [];
    for (const p of planned) {
      if (p.blob !== undefined) continue;
      const hit = cache.get(p.path);
      if (hit && hit.mode === p.mode && hit.size === p.size && hit.mtimeNs === p.mtimeNs && hit.ino === p.ino) {
        p.blob = hit.blob;
      } else toHash.push(p);
    }
    const scratch: string[] = [];
    try {
      for (const [i, p] of toHash.entries()) {
        if (p.mode !== "120000") continue;
        // `hash-object` follows links, so a link's blob is its target text, written to a scratch file first.
        const tmp = join(scratchDir, `link-${options.session}-${i}`);
        writeFileSync(tmp, readlinkSync(join(root, p.path)));
        scratch.push(tmp);
        p.source = tmp;
      }
      if (toHash.length > 0) {
        const input = encode(`${toHash.map((p) => p.source).join("\n")}\n`);
        const args = ["hash-object", "--no-filters", "-w", "--stdin-paths"];
        const ids = lines(await runGit(ctx, args, { env: privateEnv, input }));
        if (ids.length !== toHash.length)
          throw new Error(`hash-object gave ${ids.length} ids for ${toHash.length} files`);
        for (const [i, p] of toHash.entries()) {
          const id = ids[i];
          if (id === undefined) throw new Error(`no hash for ${p.path}`);
          p.blob = id;
        }
      }
    } finally {
      for (const tmp of scratch) rmSync(tmp, { force: true });
    }

    planned.sort(byPath);
    const next: StatCache = new Map();
    const entries: string[] = [];
    for (const p of planned) {
      if (p.blob === undefined) throw new Error(`no blob id for ${p.path}`);
      entries.push(`${p.mode} ${p.blob}\t${p.path}\0`);
      // Don't trust a timestamp that is too recent: the file could change again without its mtime moving.
      if (p.mode !== "160000" && p.mtimeNs < startNs - RACY_NS) {
        next.set(p.path, { mode: p.mode, size: p.size, mtimeNs: p.mtimeNs, ino: p.ino, blob: p.blob });
      }
    }

    // Rebuild the private index from scratch from object ids only; nothing here reads the working tree.
    await runGit(ctx, ["read-tree", "--empty"], { env: privateEnv });
    if (entries.length > 0) {
      await runGit(ctx, ["update-index", "-z", "--index-info"], { env: privateEnv, input: encode(entries.join("")) });
    }
    const tree = lines(await runGit(ctx, ["write-tree"], { env: privateEnv }))[0];
    if (tree === undefined) throw new Error("write-tree printed nothing");

    cache = next;
    saveStatCache(statPath, cache);
    return { tree, hashed: toHash.length, skipped };
  }

  async function restore(tree: string, checkpointSkipped: readonly SkippedPath[]): Promise<RestoreResult> {
    if (!OBJECT_ID.test(tree)) throw new Error(`not a tree id: ${tree}`);
    const keep = new Set(checkpointSkipped.map((s) => s.path));
    const current = (await snapshot()).tree;
    // Raw records: `:<mode in tree> <mode now> <blob in tree> <blob now> <status>` NUL path NUL.
    const diff = splitNul(
      await runGit(ctx, ["diff-tree", "-r", "-z", "--no-renames", tree, current], { env: privateEnv }),
    );
    const result: RestoreResult = { written: 0, deleted: 0, skipped: [] };
    const writes: { path: string; blob: string; mode: string }[] = [];
    for (let i = 0; i + 1 < diff.length; i += 2) {
      const [srcMode, dstMode, srcBlob, , status] = (diff[i] ?? "").slice(1).split(" ");
      const path = diff[i + 1];
      if (
        srcMode === undefined ||
        dstMode === undefined ||
        srcBlob === undefined ||
        status === undefined ||
        path === undefined
      ) {
        throw new Error("unexpected diff-tree output");
      }
      if (path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) {
        throw new Error(`refusing to restore ${path}`);
      }
      if (srcMode === "160000" || dstMode === "160000") continue; // submodules are not restorable
      if (status === "A") {
        // Created after the checkpoint: delete it, unless it existed then but was left out of the tree.
        if (keep.has(path)) continue;
        const blocked = pathBlock(root, path, false);
        if (blocked) result.skipped.push({ path, reason: blocked });
        else {
          unlinkSync(join(root, path));
          removeEmptyParents(root, path);
          result.deleted++;
        }
      } else if (srcMode === "120000") {
        result.skipped.push({ path, reason: "link" });
      } else writes.push({ path, blob: srcBlob, mode: srcMode });
    }

    const blobs = await readBlobs(
      ctx,
      privateEnv,
      writes.map((w) => w.blob),
    );
    for (const w of writes) {
      const bytes = blobs.get(w.blob);
      if (bytes === undefined) throw new Error(`blob ${w.blob} for ${w.path} is not in the object store`);
      const blocked = pathBlock(root, w.path, true);
      if (blocked) {
        result.skipped.push({ path: w.path, reason: blocked });
        continue;
      }
      writeAtomic(join(root, w.path), bytes, w.mode === "100755", posix);
      result.written++;
    }
    return result;
  }

  return { snapshot, restore };
}

/** Starts a new session's stat cache from the newest other session's (they share one object store). */
function seedStatCache(sessionsDir: string, statPath: string): void {
  let newest: { file: string; mtime: number } | undefined;
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".snap.stat")) continue;
    const file = join(sessionsDir, name);
    const mtime = statSync(file).mtimeMs;
    if (newest === undefined || mtime > newest.mtime) newest = { file, mtime };
  }
  if (newest) copyFileSync(newest.file, statPath);
}

/**
 * Why `path` can't be written or deleted without going through a link or over something else, or undefined if it
 * can. With `create`, missing parent directories are made (as real directories).
 */
function pathBlock(root: string, path: string, create: boolean): SkipReason | undefined {
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st === undefined) {
      if (!create) return "blocked";
      mkdirSync(dir);
    } else if (st.isSymbolicLink()) return "link";
    else if (!st.isDirectory()) return "blocked";
  }
  const st = lstatSync(join(dir, parts.at(-1) ?? ""), { throwIfNoEntry: false });
  if (st === undefined) return create ? undefined : "blocked";
  if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) return "link";
  return st.isFile() ? undefined : "blocked";
}

/** After a delete, removes the directories it emptied (never the workspace root). */
function removeEmptyParents(root: string, path: string): void {
  let dir = dirname(join(root, path));
  while (dir !== root && dir.startsWith(root) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
    dir = dirname(dir);
  }
}

/**
 * Replaces `file` with `bytes` through a temp file in the same directory and a rename. An existing file keeps its
 * permissions (only the execute bits follow the checkpoint); a new one gets the process umask's default.
 */
function writeAtomic(file: string, bytes: Uint8Array, executable: boolean, posix: boolean): void {
  const tmp = join(dirname(file), `.dovet-restore-${crypto.randomUUID()}`);
  const existing = lstatSync(file, { throwIfNoEntry: false });
  writeFileSync(tmp, bytes, { mode: executable && posix ? 0o777 : 0o666 });
  if (posix && existing?.isFile()) {
    const readBits = existing.mode & 0o444;
    chmodSync(tmp, (existing.mode & 0o666) | (executable ? readBits >> 2 : 0));
  }
  renameSync(tmp, file);
}

/** Reads blobs by id with `git cat-file --batch`: raw bytes, no filters. */
async function readBlobs(
  ctx: GitContext,
  privateEnv: Readonly<Record<string, string>>,
  ids: readonly string[],
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (ids.length === 0) return out;
  const buf = await runGit(ctx, ["cat-file", "--batch"], { env: privateEnv, input: encode(`${ids.join("\n")}\n`) });
  let pos = 0;
  while (pos < buf.length) {
    const eol = buf.indexOf(10, pos);
    const [id, type, size] = new TextDecoder().decode(buf.subarray(pos, eol)).split(" ");
    if (id === undefined || type !== "blob" || size === undefined) throw new Error("cat-file: unexpected object");
    const start = eol + 1;
    out.set(id, buf.slice(start, start + Number(size)));
    pos = start + Number(size) + 1;
  }
  return out;
}
