// Restoring files for /rewind (checkpoints "Rewind"): what is logged, what the model is told, what read-state forgets.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AbsPath, EventEnvelope, EventType } from "../schema/index.ts";
import { createBlobStore, openCheckpoints } from "../store/index.ts";
import { createReadState } from "../tools/index.ts";
import { restoreFiles, restoreNote } from "./rewind.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const ENTRY = { sha256: "x", mtimeMs: 1, size: 1, partial: false, encoding: "utf8", eol: "\n" } as const;

/** Two turns in a plain folder: turn 1 edits a.txt and creates new.txt, turn 2 edits b.txt. */
async function session() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dovet-rewind-")));
  dirs.push(root);
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "a.txt"), "a0\n");
  writeFileSync(join(work, "b.txt"), "b0\n");
  const log: EventEnvelope[] = [];
  const record = (type: EventType, data: unknown): void => {
    log.push({ v: 1, id: String(log.length), ts: "", session: "s", epoch: 0, turn: null, type, core: true, data });
  };
  const checkpoints = await openCheckpoints({
    workspace: work,
    projectDir: join(root, "data", "projects", "p"),
    session: "s",
    env: {},
    platform: process.platform,
    blobs: createBlobStore(join(root, "data")),
    enabled: false,
    record: (data) => record("checkpoint", data),
  });
  const file = (name: string): AbsPath => join(work, name) as AbsPath;
  const write = async (name: string, before: string | null, text: string): Promise<void> => {
    await checkpoints.recordWrite(file(name), before === null ? null : new TextEncoder().encode(before));
    writeFileSync(file(name), text);
    record("file.change", {
      path: file(name),
      op: before === null ? "create" : "modify",
      added: 1,
      removed: 0,
      after: sha(text),
    });
  };
  checkpoints.beginTurn(1);
  await write("a.txt", "a0\n", "a1\n");
  await write("new.txt", null, "n1\n");
  checkpoints.beginTurn(2);
  await write("b.txt", "b0\n", "b1\n");
  const readState = createReadState(
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
  );
  for (const n of ["a.txt", "new.txt", "b.txt"]) readState.set(file(n), ENTRY);
  const pushed: { type: string; data: Record<string, unknown> }[] = [];
  const deps = {
    checkpoints,
    readState,
    push: (type: string, data: unknown) => pushed.push({ type, data: data as Record<string, unknown> }),
  };
  return { work, file, log, deps, readState, pushed };
}

test("the note is the fixed text of docs/prompts/instructions.md", () => {
  expect(restoreNote(3)).toBe(
    "The user restored files to their state before turn 3. Re-read files before editing them.",
  );
});

test("restoring turn 1 puts back what turns 1 and 2 changed, logs each as a rewind, tells the model, and forgets those reads", async () => {
  const s = await session();
  const result = await restoreFiles(s.deps, s.log, 1, "overwrite");
  expect(result).toMatchObject({ written: 2, deleted: 1, failed: [] });
  expect(readFileSync(s.file("a.txt"), "utf8")).toBe("a0\n");
  expect(readFileSync(s.file("b.txt"), "utf8")).toBe("b0\n");

  const changes = s.pushed.filter((p) => p.type === "file.change");
  expect(changes.map((c) => `${c.data.op}:${c.data.path}`).sort()).toEqual([
    `delete:${s.file("new.txt")}`,
    `modify:${s.file("a.txt")}`,
    `modify:${s.file("b.txt")}`,
  ]);
  const a = changes.find((c) => c.data.path === s.file("a.txt"));
  expect(a?.data).toMatchObject({ via: "rewind", before: sha("a1\n"), after: sha("a0\n") });
  const note = s.pushed.filter((p) => p.type === "system.injected");
  expect(note.map((n) => n.data)).toEqual([
    { text: restoreNote(1), reason: "restore-note", delivery: "reminder-block" },
  ]);
  for (const n of ["a.txt", "new.txt", "b.txt"]) expect(s.readState.get(s.file(n))).toBeUndefined();
});

test("a skipped conflict keeps its file and its read-state, and the rest still restores", async () => {
  const s = await session();
  writeFileSync(s.file("a.txt"), "typed by the user\n");
  expect(await s.deps.checkpoints.conflicts(s.log, "c1")).toEqual([s.file("a.txt")]);
  const result = await restoreFiles(s.deps, s.log, 1, "skip");
  expect(result.skipped).toEqual([{ path: s.file("a.txt"), reason: "conflict" }]);
  expect(readFileSync(s.file("a.txt"), "utf8")).toBe("typed by the user\n");
  expect(readFileSync(s.file("b.txt"), "utf8")).toBe("b0\n");
  expect(s.readState.get(s.file("a.txt"))).toBeDefined();
  expect(s.readState.get(s.file("b.txt"))).toBeUndefined();
});

test("a turn that changed nothing restores from the next checkpoint, and with none after it nothing happens", async () => {
  const s = await session();
  s.deps.checkpoints.beginTurn(3);
  const later = await restoreFiles(s.deps, s.log, 2, "overwrite");
  expect(later.written).toBe(1);
  expect(readFileSync(s.file("b.txt"), "utf8")).toBe("b0\n");
  expect(readFileSync(s.file("a.txt"), "utf8")).toBe("a1\n");

  const none = await restoreFiles(s.deps, s.log, 3, "overwrite");
  expect(none).toEqual({ written: 0, deleted: 0, skipped: [], failed: [], changes: [] });
  expect(s.pushed.filter((p) => p.type === "system.injected")).toHaveLength(1);
});
