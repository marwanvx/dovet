// Checkpoints (docs/specs/checkpoints.md): when the snapshot or the blob fallback is taken, and what rewinding does. Real git, real files.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AbsPath, CheckpointData, type EventEnvelope } from "../../schema/index.ts";
import { createBlobStore } from "../blobs/index.ts";
import { type CheckpointService, openCheckpoints } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 120_000);

const ENV: Record<string, string | undefined> = { ...process.env };
for (const key of Object.keys(ENV)) if (key.toUpperCase().startsWith("GIT_")) delete ENV[key];

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: ENV },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

interface Rig {
  work: string;
  data: string;
  events: CheckpointData[];
  open: (over?: { enabled?: boolean; slowMs?: number; session?: string }) => Promise<CheckpointService>;
  envelopes: () => EventEnvelope[];
}

/** A workspace named with a space; a git repository with the files committed, or a plain directory. */
function rig(files: Record<string, string | Uint8Array>, inGit: boolean, age = true): Rig {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dovet-ckpt-")));
  dirs.push(root);
  const work = join(root, "work tree");
  mkdirSync(work);
  const made = new Set<string>();
  for (const [path, data] of Object.entries(files)) {
    const dir = join(work, path, "..");
    if (!made.has(dir)) {
      mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    writeFileSync(join(work, path), data);
  }
  if (inGit) {
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "init");
  }
  const past = new Date(Date.now() - 3_600_000);
  if (age) for (const path of Object.keys(files)) utimesSync(join(work, path), past, past);
  const data = join(root, "data");
  const events: CheckpointData[] = [];
  return {
    work,
    data,
    events,
    envelopes: () => events.map((e) => ({ type: "checkpoint", data: e }) as EventEnvelope),
    open: (over = {}) =>
      openCheckpoints({
        workspace: work,
        projectDir: join(data, "projects", "p"),
        session: over.session ?? "s1",
        env: ENV,
        platform: process.platform,
        blobs: createBlobStore(data),
        enabled: over.enabled ?? true,
        ...(over.slowMs === undefined ? {} : { slowMs: over.slowMs }),
        record: (e) => events.push(CheckpointData.parse(e)),
      }),
  };
}

const abs = (r: Rig, name: string): AbsPath => join(r.work, name) as AbsPath;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("when a checkpoint is taken", () => {
  test("a git workspace snapshots before the turn's first change, once per turn, and not for a turn that changes nothing", async () => {
    const r = rig({ "a.txt": "one\n" }, true);
    const svc = await r.open();
    expect(svc.mechanism).toBe("git-tree");
    svc.beginTurn(1);
    expect(r.events).toEqual([]);
    await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
    await svc.recordWrite(abs(r, "b.txt"), null);
    svc.beginTurn(2);
    svc.beginTurn(3);
    await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
    expect(r.events.map((e) => `${e.id}:${e.mechanism}`)).toEqual(["c1:git-tree", "c3:git-tree"]);
  });

  test("a shell command's own before-snapshot is the turn's checkpoint, and a later file write adds no second one", async () => {
    const r = rig({ "a.txt": "one\n" }, true);
    const svc = await r.open();
    svc.beginTurn(1);
    const before = await svc.shell?.snapshot();
    await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ id: "c1", mechanism: "git-tree", tree: before?.tree });
  });

  test("outside git, or with checkpoints off, only the files Dovet's tools change are kept, once per path per turn", async () => {
    for (const [inGit, enabled] of [
      [false, true],
      [true, false],
    ] as const) {
      const r = rig({ "a.txt": "one\n" }, inGit);
      const svc = await r.open({ enabled });
      expect(svc.mechanism).toBe("blobs");
      expect(svc.shell).toBeUndefined();
      svc.beginTurn(1);
      await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
      await svc.recordWrite(abs(r, "a.txt"), bytes("two\n"));
      await svc.recordWrite(abs(r, "new.txt"), null);
      expect(r.events.flatMap((e) => (e.mechanism === "blobs" ? e.files.map((f) => f.path) : []))).toEqual([
        abs(r, "a.txt"),
        abs(r, "new.txt"),
      ]);
      expect(new Set(r.events.map((e) => e.id))).toEqual(new Set(["c1"]));
    }
  });

  test("a snapshot over the time limit turns shell snapshots off with a notice, and later turns use blobs", async () => {
    const r = rig({ "a.txt": "one\n" }, true);
    const svc = await r.open({ slowMs: -1 });
    svc.beginTurn(1);
    await svc.shell?.snapshot();
    expect(svc.shell).toBeUndefined();
    expect(svc.shellNotice()).toContain("took");
    expect(svc.shellNotice()).toBeUndefined();
    svc.beginTurn(2);
    await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
    expect(r.events.map((e) => `${e.id}:${e.mechanism}`)).toEqual(["c1:git-tree", "c2:blobs"]);
    expect(svc.shellNotice()).toContain("took");
  });

  test("the not-restorable notice for shell commands comes once per turn", async () => {
    const r = rig({}, false);
    const svc = await r.open();
    svc.beginTurn(1);
    expect(svc.shellNotice()).toMatch(/shell commands.*can't be undone/s);
    expect(svc.shellNotice()).toBeUndefined();
    svc.beginTurn(2);
    expect(svc.shellNotice()).toBeDefined();
  });
});

describe("rewinding", () => {
  // spec: AC-CKPT-06
  test("outside git, Edit and Write changes come back from the blobs and a created file is deleted", async () => {
    const r = rig({ "a.txt": "one\n", "b.txt": "bee\n" }, false);
    const svc = await r.open();
    svc.beginTurn(1);
    await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
    writeFileSync(join(r.work, "a.txt"), "edited\n");
    await svc.recordWrite(abs(r, "new.txt"), null);
    writeFileSync(join(r.work, "new.txt"), "created\n");
    svc.beginTurn(2);
    await svc.recordWrite(abs(r, "b.txt"), bytes("bee\n"));
    writeFileSync(join(r.work, "b.txt"), "changed\n");

    const result = await svc.restore(r.envelopes(), "c1");
    expect(result).toMatchObject({ written: 2, deleted: 1, failed: [] });
    expect(readFileSync(join(r.work, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(r.work, "b.txt"), "utf8")).toBe("bee\n");
    expect(existsSync(join(r.work, "new.txt"))).toBe(false);
  });

  // spec: AC-CKPT-06
  test("a file changed in two turns comes back as it was before the earlier one", async () => {
    const r = rig({ "a.txt": "one\n" }, false);
    const svc = await r.open();
    svc.beginTurn(1);
    await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
    writeFileSync(join(r.work, "a.txt"), "two\n");
    svc.beginTurn(2);
    await svc.recordWrite(abs(r, "a.txt"), bytes("two\n"));
    writeFileSync(join(r.work, "a.txt"), "three\n");
    await svc.restore(r.envelopes(), "c1");
    expect(readFileSync(join(r.work, "a.txt"), "utf8")).toBe("one\n");
  });

  test.skipIf(process.platform === "win32")(
    "a path that became a symlink or a hard link is skipped, never written through",
    async () => {
      const r = rig({ "a.txt": "one\n", "b.txt": "bee\n", "target.txt": "target\n", "other.txt": "other\n" }, false);
      const svc = await r.open();
      svc.beginTurn(1);
      await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
      await svc.recordWrite(abs(r, "b.txt"), bytes("bee\n"));
      rmSync(join(r.work, "a.txt"));
      symlinkSync(join(r.work, "target.txt"), join(r.work, "a.txt"));
      linkSync(join(r.work, "other.txt"), join(r.work, "b.txt.link"));
      rmSync(join(r.work, "b.txt"));
      linkSync(join(r.work, "other.txt"), join(r.work, "b.txt"));
      const result = await svc.restore(r.envelopes(), "c1");
      expect(result.skipped.map((s) => `${s.path}:${s.reason}`).sort()).toEqual([
        `${abs(r, "a.txt")}:link`,
        `${abs(r, "b.txt")}:link`,
      ]);
      expect(readFileSync(join(r.work, "target.txt"), "utf8")).toBe("target\n");
      expect(readFileSync(join(r.work, "other.txt"), "utf8")).toBe("other\n");
    },
  );

  test("restoring turn 2 leaves turn 1's changes alone", async () => {
    const r = rig({ "a.txt": "one\n" }, false);
    const svc = await r.open();
    svc.beginTurn(1);
    await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
    writeFileSync(join(r.work, "a.txt"), "two\n");
    svc.beginTurn(2);
    await svc.recordWrite(abs(r, "a.txt"), bytes("two\n"));
    writeFileSync(join(r.work, "a.txt"), "three\n");
    await svc.restore(r.envelopes(), "c2");
    expect(readFileSync(join(r.work, "a.txt"), "utf8")).toBe("two\n");
  });

  test("a blob that is gone is named and the rewind does not report success", async () => {
    const r = rig({ "a.txt": "one\n" }, false);
    const svc = await r.open();
    svc.beginTurn(1);
    await svc.recordWrite(abs(r, "a.txt"), bytes("one\n"));
    writeFileSync(join(r.work, "a.txt"), "edited\n");
    rmSync(join(r.data, "blobs"), { recursive: true });
    const result = await svc.restore(r.envelopes(), "c1");
    expect(result.failed).toEqual([abs(r, "a.txt")]);
    expect(readFileSync(join(r.work, "a.txt"), "utf8")).toBe("edited\n");
  });

  test("an unknown checkpoint is an error", async () => {
    const r = rig({}, false);
    const svc = await r.open();
    expect(svc.restore(r.envelopes(), "c9")).rejects.toThrow("c9");
  });

  // spec: AC-CKPT-09
  test.each([
    ["a git workspace", true],
    ["a plain folder", false],
  ])("CRLF files in a path with spaces round-trip byte for byte in %s", async (_name, inGit) => {
    const crlf = "line one\r\nline two\r\n";
    const r = rig({ "dir with space/win file.txt": crlf, "unix.txt": "a\nb\n" }, inGit);
    const svc = await r.open();
    svc.beginTurn(1);
    const file = abs(r, "dir with space/win file.txt");
    if (inGit) await svc.shell?.snapshot();
    else await svc.recordWrite(file, bytes(crlf));
    writeFileSync(file, "changed\r\n");
    writeFileSync(join(r.work, "dir with space", "new file.txt"), "made\r\n");
    if (inGit) await svc.recordWrite(file, bytes(crlf));
    else await svc.recordWrite(abs(r, "dir with space/new file.txt"), null);
    await svc.restore(r.envelopes(), "c1");
    expect(readFileSync(file)).toEqual(Buffer.from(crlf));
    expect(existsSync(join(r.work, "dir with space", "new file.txt"))).toBe(false);
    expect(readFileSync(join(r.work, "unix.txt"), "utf8")).toBe("a\nb\n");
  });

  test("a git checkpoint restores a shell-made change through the tree, deleting what the command created", async () => {
    const r = rig({ "a.txt": "one\n", "gone.txt": "bye\n" }, true);
    const svc = await r.open();
    svc.beginTurn(1);
    await svc.shell?.snapshot();
    writeFileSync(join(r.work, "a.txt"), "edited\n");
    rmSync(join(r.work, "gone.txt"));
    writeFileSync(join(r.work, "made.txt"), "new\n");
    const result = await svc.restore(r.envelopes(), "c1");
    expect(result).toMatchObject({ written: 2, deleted: 1 });
    expect(readFileSync(join(r.work, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(r.work, "gone.txt"), "utf8")).toBe("bye\n");
    expect(existsSync(join(r.work, "made.txt"))).toBe(false);
  });
});

describe("speed", () => {
  // spec: AC-CKPT-05
  test("the second snapshot of an unchanged 10,000-file repository is fast", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10_000; i++) files[`d${i % 100}/f${i}.txt`] = `file ${i}\n`;
    // 10,000 utimes calls are slow on Windows; waiting out the 2 s racy-timestamp window does the same.
    const r = rig(files, true, false);
    await Bun.sleep(2100);
    const svc = await r.open({ slowMs: 1_000_000 });
    svc.beginTurn(1);
    const first = await svc.shell?.snapshot();
    // The fastest of three, so a busy CI runner's hiccup doesn't decide it.
    const runs: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const again = await svc.shell?.snapshot();
      runs.push(performance.now() - t0);
      expect(again?.tree).toBe(first?.tree ?? "");
      expect(again?.hashed).toBe(0);
    }
    console.log(`second snapshot of 10,000 files, ms: ${runs.map(Math.round).join(", ")}`);
    expect(Math.min(...runs)).toBeLessThan(process.platform === "win32" ? 400 : 200);
  }, 300_000);
});
