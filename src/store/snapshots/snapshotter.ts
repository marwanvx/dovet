// Git tree snapshots (docs/specs/checkpoints.md "Git tree snapshots", ADR-19): a tree object per checkpoint, built in a
// private object directory with a private index, from the raw bytes on disk. Nothing is written into the user's `.git`,
// and `git add` / `checkout` (which run clean/smudge/process filters) are never used.
import { chmodSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Env, emptyDir, type GitContext, lines, runGit, scrubbedEnv, splitNul } from "./git.ts";
import { loadStatCache, type StatCache, saveStatCache } from "./stat-cache.ts";

const UNTRACKED_LIMIT = 2n * 1024n * 1024n;
const FILE_LIMIT = 50_000_000n;
/** A file modified this recently may change again within the filesystem's timestamp granularity. */
const RACY_NS = 2_000_000_000n;

export interface SnapshotterOptions {
  /** Any directory inside the repository; snapshots cover the repository's top level. */
  workspace: string;
  /** `<data>/projects/<id>`: holds `objects/` (shared by sessions) and `sessions/` (one index + stat cache each). */
  projectDir: string;
  session: string;
  /** The caller's environment (only `cli/main.ts` reads `process.env`); `GIT_*` variables are dropped. */
  env: Env;
}

export type SkipReason = "too-large" | "nested-repo" | "gitlink" | "unsupported" | "link" | "blocked";
export interface SkippedPath {
  path: string;
  reason: SkipReason;
}

export interface SnapshotResult {
  /** Tree object id in the private object store. */
  tree: string;
  /** Files whose bytes were read and hashed this time (the rest came from the stat cache). */
  hashed: number;
  /** Paths left out of the tree; the receipt lists them as not restorable. */
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
  /** Makes the workspace match `tree`: rewrites changed files, deletes files created since. */
  restore(tree: string): Promise<RestoreResult>;
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

export async function openSnapshotter(options: SnapshotterOptions): Promise<Snapshotter> {
  const env = scrubbedEnv(options.env);
  const objectsDir = emptyDir(join(options.projectDir, "objects"));
  const sessionsDir = emptyDir(join(options.projectDir, "sessions"));
  const scratchDir = emptyDir(join(options.projectDir, "scratch"));
  const hooksDir = emptyDir(join(options.projectDir, "empty-hooks"));
  const indexPath = join(sessionsDir, `${options.session}.snap.index`);
  const statPath = join(sessionsDir, `${options.session}.snap.stat`);

  const [top, common] = lines(
    await runGit({ cwd: options.workspace, env, hooksDir }, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]),
  );
  if (top === undefined || common === undefined) throw new Error(`${options.workspace} is not in a git repository`);
  const root = resolve(top);
  const ctx: GitContext = { cwd: root, env, hooksDir };
  // Linked worktrees keep their objects in the main repository: `--git-common-dir` finds them.
  const privateEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_OBJECT_DIRECTORY: objectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(resolve(common), "objects"),
  };

  let cache = loadStatCache(statPath);

  async function snapshot(): Promise<SnapshotResult> {
    const startNs = BigInt(Date.now()) * 1_000_000n;
    const skipped: SkippedPath[] = [];
    const planned: Planned[] = [];

    // The user's real index, read-only: no GIT_INDEX_FILE override, no filters, .gitignore respected.
    const tracked = new Set(splitNul(await runGit(ctx, ["ls-files", "-z", "--cached"])));
    const untracked = splitNul(await runGit(ctx, ["ls-files", "-z", "--others", "--exclude-standard"]));
    for (const path of [...tracked, ...untracked]) {
      if (path.endsWith("/")) {
        skipped.push({ path, reason: "nested-repo" });
        continue;
      }
      if (path.includes("\n")) {
        skipped.push({ path, reason: "unsupported" }); // `--stdin-paths` is newline-separated
        continue;
      }
      const full = join(root, path);
      const st = lstatSync(full, { bigint: true, throwIfNoEntry: false });
      if (st === undefined) continue; // tracked, but deleted on disk
      const base = { path, size: st.size, mtimeNs: st.mtimeNs, ino: st.ino, source: full };
      if (st.isDirectory()) {
        skipped.push({ path, reason: "gitlink" });
      } else if (st.isSymbolicLink()) {
        planned.push({ ...base, mode: "120000" });
      } else if (st.isFile()) {
        if (st.size > FILE_LIMIT || (!tracked.has(path) && st.size > UNTRACKED_LIMIT)) {
          skipped.push({ path, reason: "too-large" });
          continue;
        }
        const exec = process.platform !== "win32" && (st.mode & 0o111n) !== 0n;
        planned.push({ ...base, mode: exec ? "100755" : "100644" });
      } else {
        skipped.push({ path, reason: "unsupported" });
      }
    }

    // Unchanged files take their blob id from the stat cache; the rest are hashed in one git process.
    const toHash: Planned[] = [];
    for (const p of planned) {
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
        const ids = lines(
          await runGit(ctx, ["hash-object", "--no-filters", "-w", "--stdin-paths"], { env: privateEnv, input }),
        );
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

    planned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const next: StatCache = new Map();
    const entries: string[] = [];
    for (const p of planned) {
      if (p.blob === undefined) throw new Error(`no blob id for ${p.path}`);
      entries.push(`${p.mode} ${p.blob}\t${p.path}\0`);
      // Don't trust a timestamp that is too recent: the file could change again without its mtime moving.
      if (p.mtimeNs < startNs - RACY_NS) {
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

  async function restore(tree: string): Promise<RestoreResult> {
    const current = (await snapshot()).tree;
    // Raw records: `:<mode in tree> <mode now> <blob in tree> <blob now> <status>` NUL path NUL.
    const diff = splitNul(
      await runGit(ctx, ["diff-tree", "-r", "-z", "--no-renames", tree, current], { env: privateEnv }),
    );
    const result: RestoreResult = { written: 0, deleted: 0, skipped: [] };
    const writes: { path: string; blob: string; mode: string }[] = [];
    for (let i = 0; i + 1 < diff.length; i += 2) {
      const [srcMode, , srcBlob, , status] = (diff[i] ?? "").slice(1).split(" ");
      const path = diff[i + 1];
      if (srcMode === undefined || srcBlob === undefined || status === undefined || path === undefined) {
        throw new Error("unexpected diff-tree output");
      }
      if (path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) {
        throw new Error(`refusing to restore ${path}`);
      }
      if (status === "A") {
        // Created after the checkpoint: delete it, unless a link is in the way.
        const blocked = pathBlock(root, path, false);
        if (blocked) result.skipped.push({ path, reason: blocked });
        else {
          unlinkSync(join(root, path));
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
      writeAtomic(join(root, w.path), bytes, w.mode === "100755");
      result.written++;
    }
    return result;
  }

  return { snapshot, restore };
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

/** Replaces `file` with `bytes` through a temp file in the same directory and a rename. */
function writeAtomic(file: string, bytes: Uint8Array, executable: boolean): void {
  const tmp = join(dirname(file), `.dovet-restore-${crypto.randomUUID()}`);
  writeFileSync(tmp, bytes);
  if (process.platform !== "win32") chmodSync(tmp, executable ? 0o755 : 0o644);
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
