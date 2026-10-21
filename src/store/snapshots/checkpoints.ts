// When a checkpoint is taken and how a rewind uses it (docs/specs/checkpoints.md): the git tree snapshot of snapshotter.ts
// where the workspace allows it, the before-bytes of the files Dovet's own tools change where it doesn't.
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { hardenedGitEnv } from "../../platform/index.ts";
import { CheckpointData, type EventEnvelope } from "../../schema/index.ts";
import type { BlobStore } from "../blobs/index.ts";
import { emptyDir, runGit } from "./git.ts";
import {
  openSnapshotter,
  type SkippedPath,
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

export interface RewindResult {
  written: number;
  deleted: number;
  /** Paths left alone because writing could go through a link, or something is in the way. */
  skipped: SkippedPath[];
  /** Paths whose saved bytes were missing: the rewind did not complete. */
  failed: string[];
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
  /** Puts the workspace back to checkpoint `id` from the logged `checkpoint` events. */
  restore(events: readonly EventEnvelope[], id: string): Promise<RewindResult>;
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
    if (result.timings.total > slowMs) {
      degrade(`a snapshot took ${(result.timings.total / 1000).toFixed(1)} s`);
    }
    return result;
  }

  const shell =
    snapshotter === undefined
      ? undefined
      : { root: snapshotter.root, snapshot: snap, changes: snapshotter.changes.bind(snapshotter) };

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
    async restore(events, checkpointId) {
      const all = events.filter((e) => e.type === "checkpoint").map((e) => CheckpointData.parse(e.data));
      const chosen = all.filter((c) => c.id === checkpointId);
      const first = chosen[0];
      if (first === undefined) throw new Error(`no checkpoint ${checkpointId}`);
      const tree = chosen.find((c) => c.mechanism === "git-tree");
      if (tree?.mechanism === "git-tree") {
        if (snapshotter === undefined)
          throw new Error(`checkpoint ${checkpointId} is a git snapshot and git is unusable here`);
        const r = await snapshotter.restore(tree.tree, tree.skipped);
        return { written: r.written, deleted: r.deleted, skipped: r.skipped, failed: [] };
      }
      // The earliest saved state of each path in this turn and after it.
      const wanted = new Map<string, string | null>();
      for (const c of all) {
        if (c.mechanism !== "blobs" || c.turn < first.turn) continue;
        for (const f of c.files) if (!wanted.has(f.path)) wanted.set(f.path, f.before);
      }
      const result: RewindResult = { written: 0, deleted: 0, skipped: [], failed: [] };
      for (const [path, sha] of wanted) {
        const st = lstatSync(path, { throwIfNoEntry: false });
        if (st !== undefined && (st.isSymbolicLink() || (st.isFile() && st.nlink > 1))) {
          result.skipped.push({ path, reason: "link" });
        } else if (sha === null) {
          if (st !== undefined) {
            rmSync(path);
            result.deleted++;
          }
        } else {
          const saved = await options.blobs.get(sha);
          if (saved === undefined) {
            result.failed.push(path);
            continue;
          }
          mkdirSync(dirname(path), { recursive: true });
          const exec = st !== undefined && (st.mode & 0o111) !== 0 && options.platform !== "win32";
          writeAtomic(path, saved, exec, options.platform !== "win32");
          if (hex(readFileSync(path)) !== sha) result.failed.push(path);
          else result.written++;
        }
      }
      return result;
    },
  };
}
