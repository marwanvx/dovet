// When a checkpoint is taken and how a rewind uses it (docs/specs/checkpoints.md): the git tree snapshot of snapshotter.ts
// where the workspace allows it, the before-bytes of the files Dovet's own tools change where it doesn't.
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { hardenedGitEnv, pathKey } from "../../platform/index.ts";
import { CheckpointData, type EventEnvelope, FileChangeData } from "../../schema/index.ts";
import type { BlobStore } from "../blobs/index.ts";
import { emptyDir, runGit } from "./git.ts";
import {
  openSnapshotter,
  pathBlock,
  type RestoreSkip,
  type SnapshotResult,
  type Snapshotter,
  type SnapshotterOptions,
  writeAtomic,
} from "./snapshotter.ts";

/** A snapshot slower than this turns shell snapshots off for the session (checkpoints "Limits"). */
const SLOW_MS = 2000;
const MIN_GIT = [2, 20] as const;

export interface CheckpointOptions extends SnapshotterOptions {
  blobs: BlobStore;
  /** `checkpoints.enabled`: false keeps only the blobs for Dovet's own tool edits. */
  enabled: boolean;
  slowMs?: number;
  /** Writes the `checkpoint` event. */
  record(data: CheckpointData): void;
}

/** One file a rewind changed; hashes are SHA-256, and `before` is kept in the blob store so the rewind can be undone. */
export interface RewindChange {
  path: string;
  op: "create" | "modify" | "delete";
  before: string | null;
  after: string | null;
}

/** All paths are absolute. */
export interface RewindResult {
  written: number;
  deleted: number;
  /** Paths left alone: a link now, something in the way, or a conflict the caller chose to skip. */
  skipped: RestoreSkip[];
  /** Paths whose saved bytes were missing or did not read back as written: the rewind did not complete. */
  failed: string[];
  changes: RewindChange[];
}

export interface CheckpointService {
  /** What the next change is protected by. */
  readonly mechanism: "git-tree" | "blobs";
  /** The turn whose first change takes the checkpoint `c<turn>`. */
  beginTurn(turn: number): void;
  /** Awaited by a file tool before it changes a file (`null` = it creates the file). */
  recordWrite(path: string, before: Uint8Array | null): Promise<void>;
  /** For Bash: a snapshot before and after a command; absent when shell changes can't be undone. */
  readonly shell: Pick<Snapshotter, "root" | "snapshot" | "changes"> | undefined;
  /** Why shell changes can't be undone, once per turn. */
  shellNotice(): string | undefined;
  /**
   * Paths a rewind to checkpoint `id` would overwrite or delete although they are not as Dovet last left them
   * (the `after` of the latest `file.change` for the path): changed by the user or outside Dovet, or with no record.
   */
  conflicts(events: readonly EventEnvelope[], id: string): Promise<string[]>;
  /** Puts the workspace back to checkpoint `id` from the logged events; `skip` leaves the conflicts alone, `overwrite` takes them too. */
  restore(events: readonly EventEnvelope[], id: string, onConflict: "overwrite" | "skip"): Promise<RewindResult>;
}

async function gitUsable(options: SnapshotterOptions): Promise<string | undefined> {
  const dir = emptyDir(`${options.projectDir}/empty-hooks`);
  let out: string;
  try {
    out = new TextDecoder().decode(
      await runGit({ cwd: options.workspace, env: hardenedGitEnv(options.env), hooksDir: dir }, ["--version"]),
    );
  } catch (e) {
    return `git can't be run (${e instanceof Error ? e.message : String(e)})`;
  }
  const m = /(\d+)\.(\d+)/.exec(out);
  const [major, minor] = [Number(m?.[1]), Number(m?.[2])];
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])
    ? undefined
    : `git ${MIN_GIT.join(".")} or newer is needed`;
}

async function openGit(options: SnapshotterOptions): Promise<{ snapshotter?: Snapshotter; why?: string }> {
  const why = await gitUsable(options);
  if (why !== undefined) return { why };
  try {
    return { snapshotter: await openSnapshotter(options) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { why: message.includes("not in a git repository") ? "this folder isn't in a git repository" : message };
  }
}

const hex = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export async function openCheckpoints(options: CheckpointOptions): Promise<CheckpointService> {
  const slowMs = options.slowMs ?? SLOW_MS;
  const opened = options.enabled
    ? await openGit(options)
    : { why: "checkpoints are turned off for this project (checkpoints.enabled)" };
  const snapshotter = opened.snapshotter;
  let shellOff = snapshotter === undefined ? (opened.why ?? "no snapshot service") : undefined;
  let turn = 0;
  let checkpointed = false;
  const recorded = new Set<string>();
  let noticed = false;

  /** The git path's link check on every directory above `path`: below the workspace, or from the drive root outside it. */
  function blobPathBlock(path: string, create: boolean): RestoreSkip["reason"] | undefined {
    const inside = relative(options.workspace, path);
    const below = inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
    const base = below ? options.workspace : parse(path).root;
    return pathBlock(base, relative(base, path).split(sep).join("/"), create);
  }

  const osOf = options.platform === "win32" ? "win32" : options.platform === "darwin" ? "darwin" : "linux";
  const id = (): string => `c${turn}`;
  const degrade = (why: string): void => {
    shellOff ??= why;
  };

  /** A fresh snapshot; the turn's first one is its checkpoint. */
  async function snap(): Promise<SnapshotResult> {
    if (snapshotter === undefined) throw new Error("no snapshot service");
    let result: SnapshotResult;
    try {
      result = await snapshotter.snapshot();
    } catch (e) {
      degrade(`a snapshot failed (${e instanceof Error ? e.message : String(e)})`);
      throw e;
    }
    if (!checkpointed) {
      checkpointed = true;
      options.record({ id: id(), turn, mechanism: "git-tree", tree: result.tree, skipped: result.skipped });
    }
    // Storing new content (a first snapshot, an install) is proportional to what changed; the listing, stat and index work is not.
    const overhead = result.timings.total - result.timings.hash;
    if (overhead > slowMs) degrade(`a snapshot took ${(overhead / 1000).toFixed(1)} s`);
    return result;
  }

  const shell =
    snapshotter === undefined
      ? undefined
      : { root: snapshotter.root, snapshot: snap, changes: snapshotter.changes.bind(snapshotter) };

  type Target =
    | { kind: "git"; tree: string; skipped: Extract<CheckpointData, { mechanism: "git-tree" }>["skipped"] }
    | { kind: "blobs"; wanted: Map<string, string | null> };

  /** What checkpoint `id` restores: its tree, or the earliest saved state of each path from that turn on. */
  function resolve(events: readonly EventEnvelope[], checkpointId: string): Target {
    const all = events.filter((e) => e.type === "checkpoint").map((e) => CheckpointData.parse(e.data));
    const chosen = all.filter((c) => c.id === checkpointId);
    const first = chosen[0];
    if (first === undefined) throw new Error(`no checkpoint ${checkpointId}`);
    const tree = chosen.find((c) => c.mechanism === "git-tree");
    if (tree?.mechanism === "git-tree") return { kind: "git", tree: tree.tree, skipped: tree.skipped };
    const wanted = new Map<string, string | null>();
    for (const c of all) {
      if (c.mechanism !== "blobs" || c.turn < first.turn) continue;
      for (const f of c.files) if (!wanted.has(f.path)) wanted.set(f.path, f.before);
    }
    return { kind: "blobs", wanted };
  }

  /** The conflicting paths: `abs` to report, `key` as the restore names them (relative to the repository for git). */
  async function conflictKeys(
    events: readonly EventEnvelope[],
    checkpointId: string,
  ): Promise<{ abs: string; key: string }[]> {
    const target = resolve(events, checkpointId);
    const left = new Map<string, string | null>();
    for (const e of events) {
      const c = e.type === "file.change" ? FileChangeData.safeParse(e.data) : undefined;
      if (c?.success && c.data.after !== undefined) left.set(pathKey(c.data.path, osOf), c.data.after);
    }
    let candidates: { abs: string; key: string; saved?: string | null }[];
    if (target.kind === "git") {
      if (snapshotter === undefined)
        throw new Error(`checkpoint ${checkpointId} is a git snapshot and git is unusable here`);
      const root = snapshotter.root;
      candidates = (await snapshotter.plan(target.tree, target.skipped)).map((key) => ({ abs: join(root, key), key }));
    } else {
      candidates = [...target.wanted].map(([abs, saved]) => ({ abs, key: abs, saved }));
    }
    return candidates.filter(({ abs, saved }) => {
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (st === undefined || !st.isFile() || st.isSymbolicLink() || st.nlink > 1) return false;
      const now = hex(readFileSync(abs));
      return now !== saved && left.get(pathKey(abs, osOf)) !== now;
    });
  }

  return {
    get mechanism() {
      return shellOff === undefined ? "git-tree" : "blobs";
    },
    get shell() {
      return shellOff === undefined ? shell : undefined;
    },
    beginTurn(next) {
      turn = next;
      checkpointed = false;
      recorded.clear();
      noticed = false;
    },
    async recordWrite(path, before) {
      if (turn === 0) throw new Error("recordWrite before beginTurn");
      if (shellOff === undefined) {
        if (checkpointed) return;
        try {
          await snap();
          return;
        } catch {
          // snap() recorded why in shellOff; this file falls back to its before-bytes
        }
      }
      if (recorded.has(path)) return;
      recorded.add(path);
      const sha = before === null ? null : options.blobs.putSync(before);
      options.record({ id: id(), turn, mechanism: "blobs", files: [{ path, before: sha }] });
    },
    shellNotice() {
      if (shellOff === undefined || noticed) return undefined;
      noticed = true;
      return `Checkpoints can't cover shell commands here (${shellOff}): files a command changes can't be undone. Edit and Write changes can.`;
    },
    conflicts: async (events, checkpointId) => (await conflictKeys(events, checkpointId)).map((c) => c.abs),
    async restore(events, checkpointId, onConflict) {
      const target = resolve(events, checkpointId);
      const conflicting = onConflict === "skip" ? await conflictKeys(events, checkpointId) : [];
      const result: RewindResult = { written: 0, deleted: 0, skipped: [], failed: [], changes: [] };
      const keep = (path: string, before: Uint8Array | null, after: Uint8Array | null): void => {
        result.changes.push({
          path,
          op: before === null ? "create" : after === null ? "delete" : "modify",
          before: before === null ? null : options.blobs.putSync(before),
          after: after === null ? null : hex(after),
        });
      };
      if (target.kind === "git") {
        if (snapshotter === undefined)
          throw new Error(`checkpoint ${checkpointId} is a git snapshot and git is unusable here`);
        const root = snapshotter.root;
        const r = await snapshotter.restore(target.tree, target.skipped, {
          skip: new Set(conflicting.map((c) => c.key)),
          onChange: (c) => keep(join(root, c.path), c.before, c.after),
        });
        return {
          ...result,
          written: r.written,
          deleted: r.deleted,
          skipped: r.skipped.map((s) => ({ ...s, path: join(root, s.path) })),
          failed: r.failed.map((p) => join(root, p)),
        };
      }
      const skipAbs = new Set(conflicting.map((c) => c.abs));
      for (const [path, sha] of target.wanted) {
        const st = lstatSync(path, { throwIfNoEntry: false });
        const blocked =
          st === undefined && sha === null ? undefined : blobPathBlock(path, sha !== null && !skipAbs.has(path));
        if (blocked !== undefined) {
          result.skipped.push({ path, reason: blocked });
        } else if (skipAbs.has(path)) {
          result.skipped.push({ path, reason: "conflict" });
        } else if (sha === null) {
          if (st !== undefined) {
            const before = new Uint8Array(readFileSync(path));
            rmSync(path);
            result.deleted++;
            keep(path, before, null);
          }
        } else {
          // A damaged blob throws from the store; either way this path is one the rewind could not restore.
          const saved = await options.blobs.get(sha).catch(() => undefined);
          if (saved === undefined) {
            result.failed.push(path);
            continue;
          }
          const before = st === undefined ? null : new Uint8Array(readFileSync(path));
          mkdirSync(dirname(path), { recursive: true });
          const exec = st !== undefined && (st.mode & 0o111) !== 0 && options.platform !== "win32";
          writeAtomic(path, saved, exec, options.platform !== "win32");
          const after = new Uint8Array(readFileSync(path));
          keep(path, before, after);
          if (hex(after) !== sha) result.failed.push(path);
          else result.written++;
        }
      }
      return result;
    },
  };
}

const SKIP_WORDS: Record<RestoreSkip["reason"], string> = {
  conflict: "changed since Dovet's last write",
  link: "that is a link now",
  blocked: "with something in the way",
  "too-large": "too large for a snapshot",
  gitlink: "that is a submodule",
  unsupported: "of a kind that can't be restored",
};

/** The rewind's outcome in words: counts, and every path it could not restore (checkpoints "Rewind"). */
export function describeRewind(r: RewindResult): string {
  const files = (n: number): string => `${n} file${n === 1 ? "" : "s"}`;
  const out = [`Restored ${files(r.written)}${r.deleted > 0 ? ` and deleted ${r.deleted}` : ""}.`];
  if (r.skipped.length > 0) {
    const by = new Map<string, number>();
    for (const s of r.skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
    out.push(
      `Skipped ${r.skipped.length}: ${[...by].map(([k, n]) => `${n} ${SKIP_WORDS[k as RestoreSkip["reason"]]}`).join(", ")}.`,
    );
  }
  if (r.failed.length > 0)
    out.push(
      `${r.failed.length} path${r.failed.length === 1 ? "" : "s"} could not be restored (the saved copy is missing or did not match): ${r.failed.join(", ")}. The rewind is incomplete.`,
    );
  return out.join(" ");
}
