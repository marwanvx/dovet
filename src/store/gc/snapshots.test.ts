// `dovet gc` and the private snapshot object store (checkpoints "Git tree snapshots", "Size limits", "GC"), with real git.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointData, type EventEnvelope } from "../../schema/index.ts";
import { createBlobStore } from "../blobs/index.ts";
import { openCheckpoints } from "../snapshots/index.ts";
import { runGc } from "./index.ts";

const DAY = 86_400_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  root: string;
  work: string;
  data: string;
  project: string;
  env: Record<string, string | undefined>;
  git: (...args: string[]) => string;
  /** `git` against the private object store, as a snapshot sees it. */
  store: (...args: string[]) => { code: number; out: string };
}

function rig(files: Record<string, string | Uint8Array>, gitConfig = ""): Rig {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dovet-tool-gcsnap-")));
  dirs.push(root);
  const home = join(root, "home");
  const work = join(root, "work tree");
  const data = join(root, "data");
  const project = join(data, "projects", "p1");
  mkdirSync(home);
  mkdirSync(work);
  writeFileSync(join(home, ".gitconfig"), gitConfig);
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  const run = (cwd: string, extra: Record<string, string>, ...args: string[]) =>
    Bun.spawnSync(
      ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
      {
        cwd,
        env: { ...env, ...extra },
      },
    );
  const git = (...args: string[]): string => {
    const r = run(work, {}, ...args);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  git("init", "-q", "-b", "main");
  for (const [path, data] of Object.entries(files)) writeFileSync(join(work, path), data);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const past = new Date(Date.now() - 3_600_000);
  for (const path of Object.keys(files)) utimesSync(join(work, path), past, past);
  const store = (...args: string[]) => {
    const r = run(work, { GIT_OBJECT_DIRECTORY: join(project, "objects"), GIT_DIR: join(project, "git") }, ...args);
    return { code: r.exitCode, out: r.stdout.toString() };
  };
  return { root, work, data, project, env, git, store };
}

function checkpoints(r: Rig, session: string, enabled = true) {
  const events: CheckpointData[] = [];
  const service = openCheckpoints({
    workspace: r.work,
    projectDir: r.project,
    session,
    env: r.env,
    platform: process.platform,
    blobs: createBlobStore(r.data),
    enabled,
    record: (e) => events.push(CheckpointData.parse(e)),
  });
  return { service, events };
}

/** A session log holding the given checkpoint events, last written `days` ago. */
function log(r: Rig, session: string, events: CheckpointData[], days: number): void {
  const dir = join(r.project, "sessions");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((data, i) =>
    JSON.stringify({
      v: 1,
      id: `${session}-${i}`,
      ts: "2026-01-01T00:00:00.000Z",
      session,
      epoch: 0,
      turn: data.turn,
      type: "checkpoint",
      core: true,
      data,
    }),
  );
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  const when = new Date(Date.now() - days * DAY);
  utimesSync(path, when, when);
  for (const ext of ["snap.stat", "snap.index"]) {
    const side = join(dir, `${session}.${ext}`);
    if (existsSync(side)) utimesSync(side, when, when);
  }
}

const settings = { days: 30, deleteSessions: false, outputsDays: 7 };
const gc = (r: Rig) => runGc({ data: r.data, now: Date.now(), settings, env: r.env, graceMs: 0 });
const exists = (r: Rig, oid: string): boolean => r.store("cat-file", "-e", oid).code === 0;
const treeOid = (r: Rig, tree: string, path: string): string => r.store("rev-parse", `${tree}:${path}`).out.trim();

describe("limits and the private store", () => {
  // spec: AC-CKPT-10
  test("a 5 MB untracked log and a 60 MB tracked file are not restorable, a 3 MB Edit still is, and gc keeps what a retained checkpoint needs", async () => {
    const edited = new TextEncoder().encode("x".repeat(3 * 1024 * 1024));
    const r = rig(
      { "huge.bin": new Uint8Array(60_000_000), "a.txt": "a\n" },
      "[gc]\n\tauto = 1\n\tautoPackLimit = 1\n[maintenance]\n\tauto = true\n",
    );
    writeFileSync(join(r.work, "big.log"), new Uint8Array(5 * 1024 * 1024));
    writeFileSync(join(r.work, "edit.txt"), edited);
    const past = new Date(Date.now() - 3_600_000);
    for (const f of ["big.log", "edit.txt"]) utimesSync(join(r.work, f), past, past);

    const snaps = checkpoints(r, "s1");
    const svc = await snaps.service;
    svc.beginTurn(1);
    await svc.recordWrite(join(r.work, "a.txt") as never, new TextEncoder().encode("a\n"));
    const first = snaps.events[0];
    expect(first?.mechanism).toBe("git-tree");
    if (first?.mechanism !== "git-tree") throw new Error("expected a git tree");
    expect(first.skipped.map((s) => `${s.path}:${s.reason}`).sort()).toEqual([
      "big.log:too-large",
      "edit.txt:too-large",
      "huge.bin:too-large",
    ]);

    // A 3 MB Edit with git out of the picture is kept as a blob and rewinds.
    const blobs = checkpoints(r, "s2", false);
    const blobSvc = await blobs.service;
    blobSvc.beginTurn(1);
    await blobSvc.recordWrite(join(r.work, "edit.txt") as never, edited);
    writeFileSync(join(r.work, "edit.txt"), "edited\n");
    const rewind = await blobSvc.restore(
      blobs.events.map((data) => ({ type: "checkpoint", data }) as EventEnvelope),
      "c1",
      "overwrite",
    );
    expect(rewind.failed).toEqual([]);
    expect(readFileSync(join(r.work, "edit.txt"))).toEqual(Buffer.from(edited));

    // 100 more snapshots: the repository's own `gc.auto` is set to 1, and none ran.
    let kept: CheckpointData | undefined;
    const sessionLog: CheckpointData[] = [];
    const snap = (await openSnapshotterFor(r, "s3")).snapshot;
    let tree50 = "";
    let tree10 = "";
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(r.work, "a.txt"), `a ${i}\n`);
      const { tree } = await snap();
      if (i === 10) tree10 = tree;
      if (i === 50) tree50 = tree;
      if (i === 99) kept = { id: "c3", turn: 3, mechanism: "git-tree", tree, skipped: [] };
    }
    const counts = r.store("count-objects", "-v").out;
    expect(Number(/^count: (\d+)/m.exec(counts)?.[1])).toBeGreaterThanOrEqual(100);
    expect(counts).toMatch(/^garbage: 0/m);
    expect(existsSync(join(r.project, "objects", "gc.log"))).toBe(false);

    sessionLog.push({ id: "c1", turn: 1, mechanism: "git-tree", tree: tree50, skipped: [] });
    if (kept !== undefined) sessionLog.push(kept);
    log(r, "s3", sessionLog, 1);
    const keepOids = [tree50, kept?.mechanism === "git-tree" ? kept.tree : "", treeOid(r, tree50, "a.txt")];
    const dropOid = treeOid(r, tree10, "a.txt");
    expect(exists(r, dropOid)).toBe(true);

    const report = await gc(r);

    expect(report.problems).toEqual([]);
    for (const oid of keepOids) expect(exists(r, oid)).toBe(true);
    const everything = r
      .store("ls-tree", "-r", "-t", tree50)
      .out.split("\n")
      .filter((l) => l !== "");
    for (const line of everything) expect(exists(r, line.split(/\s+/)[2] ?? "")).toBe(true);
    expect(exists(r, dropOid)).toBe(false);
    expect(exists(r, tree10)).toBe(false);
  }, 180_000);
});

async function openSnapshotterFor(r: Rig, session: string) {
  const { openSnapshotter } = await import("../snapshots/index.ts");
  return openSnapshotter({ workspace: r.work, projectDir: r.project, session, env: r.env, platform: process.platform });
}

describe("snapshot objects and expiry", () => {
  // spec: AC-CKPT-10
  test("objects only an expired session's checkpoint needs are pruned, the live session's checkpoint and cache still work", async () => {
    const r = rig({ "x.txt": "base\n", "keep.txt": "same everywhere\n" });
    writeFileSync(join(r.work, "x.txt"), "only the old session saw this\n");
    const old = await openSnapshotterFor(r, "old");
    const oldTree = (await old.snapshot()).tree;
    writeFileSync(join(r.work, "x.txt"), "current\n");
    const live = await openSnapshotterFor(r, "live");
    const liveTree = (await live.snapshot()).tree;
    log(r, "old", [{ id: "c1", turn: 1, mechanism: "git-tree", tree: oldTree, skipped: [] }], 45);
    log(r, "live", [{ id: "c1", turn: 1, mechanism: "git-tree", tree: liveTree, skipped: [] }], 1);
    const oldBlob = treeOid(r, oldTree, "x.txt");
    expect(exists(r, oldBlob)).toBe(true);

    const report = await gc(r);

    expect(report.problems).toEqual([]);
    expect(exists(r, oldBlob)).toBe(false);
    expect(exists(r, oldTree)).toBe(false);
    expect(exists(r, liveTree)).toBe(true);
    expect(exists(r, treeOid(r, liveTree, "keep.txt"))).toBe(true);
    expect(existsSync(join(r.project, "sessions", "old.snap.stat"))).toBe(false);
    expect(existsSync(join(r.project, "sessions", "live.snap.stat"))).toBe(true);

    // The next session seeds its cache from the live one and still snapshots and restores.
    const next = await openSnapshotterFor(r, "next");
    const again = await next.snapshot();
    expect(again.tree).toBe(liveTree);
    writeFileSync(join(r.work, "x.txt"), "changed again\n");
    await next.restore(liveTree, []);
    expect(readFileSync(join(r.work, "x.txt"), "utf8")).toBe("current\n");
  }, 60_000);

  test("a project with a live session is left alone", async () => {
    const r = rig({ "x.txt": "base\n" });
    writeFileSync(join(r.work, "x.txt"), "old only\n");
    const old = await openSnapshotterFor(r, "old");
    const oldTree = (await old.snapshot()).tree;
    log(r, "old", [{ id: "c1", turn: 1, mechanism: "git-tree", tree: oldTree, skipped: [] }], 45);
    const lock = join(r.project, "sessions", "other.lock");
    writeFileSync(lock, "{}");
    log(r, "other", [], 0);

    const report = await gc(r);

    expect(exists(r, oldTree)).toBe(true);
    expect(report.projectsSkipped).toEqual(["p1"]);
  }, 60_000);

  test("without git the files are still collected and the problem is reported", async () => {
    const r = rig({ "x.txt": "base\n" });
    const old = await openSnapshotterFor(r, "old");
    const oldTree = (await old.snapshot()).tree;
    log(r, "old", [{ id: "c1", turn: 1, mechanism: "git-tree", tree: oldTree, skipped: [] }], 45);
    const orphan = createBlobStore(r.data).putSync(new Uint8Array([1, 2, 3]));
    const blob = join(r.data, "blobs", orphan.slice(0, 2), orphan);
    utimesSync(blob, new Date(0), new Date(0));

    const report = await runGc({
      data: r.data,
      now: Date.now(),
      settings,
      env: { PATH: join(r.root, "no-git") },
      graceMs: 0,
    });

    expect(existsSync(blob)).toBe(false);
    expect(report.problems.join("\n")).toMatch(/p1/);
  }, 60_000);
});
