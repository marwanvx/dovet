// Forking at a turn for /rewind (checkpoints "Rewind", event-log "Event types (v0.1)" session.fork).
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeClock, sequentialIds, type TempProject, tempProject } from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import { type EventType, UserMessageData } from "../../schema/index.ts";
import { forkAtTurn } from "./fork.ts";
import { listSessions, openSession, readSession, resumeSession, type SessionLocation, sessionPaths } from "./index.ts";

const OS: Os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const PARENT = "01J0000000000000000000000A";
const FORK = "01J0000000000000000000000B";

let dir: TempProject | undefined;
afterEach(async () => {
  await dir?.dispose();
  dir = undefined;
});

async function location(session = PARENT): Promise<SessionLocation> {
  dir ??= await tempProject({ "proj/README.md": "x" });
  return { data: join(dir.root, "data"), projectRoot: join(dir.root, "proj"), os: OS, session };
}

const deps = () => ({ ids: sequentialIds("F"), clock: fakeClock(Date.UTC(2026, 9, 14)) });

/** Four turns; turn 2 changes a file (checkpoint + file.change) and turn 1's message is large enough to become a blob. */
async function parent(loc: SessionLocation): Promise<string> {
  const r = await openSession({
    ...loc,
    clock: fakeClock(Date.UTC(2026, 9, 13)),
    ids: sequentialIds("1"),
    pid: 4242,
    host: "test-host",
    secrets: [],
    flushMs: 60_000,
  });
  if (r.mode !== "write") throw new Error(r.reason);
  const w = r.writer;
  const add = (type: EventType, turn: number | null, data: unknown): void => {
    w.append({ type, epoch: 0, turn, data });
  };
  add("session.start", null, { mode: "default" });
  add("epoch.start", null, {
    epoch: 0,
    reason: "session-start",
    provider: "example",
    model: "m",
    systemText: "sys",
    toolsJson: "[]",
    thinking: { mode: "off" },
    promptVersion: "a".repeat(64),
  });
  const big = `first 😀 ${"x".repeat(300 * 1024)}`;
  for (let turn = 1; turn <= 4; turn++) {
    add("user.message", turn, { text: turn === 1 ? big : `task ${turn} \u{1F600}` });
    if (turn === 2) {
      add("checkpoint", turn, { id: "c2", turn: 2, mechanism: "blobs", files: [{ path: "/w/a.txt", before: null }] });
      add("file.change", turn, { path: "/w/a.txt", op: "create", added: 1, removed: 0, after: "a".repeat(64) });
    }
    add("turn.end", turn, { reason: "end_turn" });
  }
  await w.close();
  return big;
}

// spec: AC-CKPT-08
test("a fork leaves the original log byte-identical and copies the events before the turn's message", async () => {
  const loc = await location();
  const big = await parent(loc);
  const before = await readFile(sessionPaths(loc).log);

  const forked = await forkAtTurn(loc, FORK, 3, deps());

  expect(Buffer.compare(await readFile(sessionPaths(loc).log), before)).toBe(0);
  expect(forked.message).toEqual({ text: "task 3 \u{1F600}" });
  const read = await readSession({ ...loc, session: FORK });
  expect(read.readOnly).toBeUndefined();
  const types = read.events.map((e) => `${e.type}:${e.turn}`);
  expect(types).toEqual([
    "session.start:null",
    "epoch.start:null",
    "user.message:1",
    "turn.end:1",
    "user.message:2",
    "checkpoint:2",
    "file.change:2",
    "turn.end:2",
    "session.fork:null",
  ]);
  expect(UserMessageData.parse(read.events[2]?.data).text).toBe(big);
  const fork = read.events.at(-1);
  expect(fork?.data).toEqual({ parent: PARENT, parentEvent: read.events.at(-2)?.id });
  expect(forked.parentEvent).toBe(read.events.at(-2)?.id ?? "");
});

test("forking at the first turn keeps only the session's opening events; a turn that isn't there is an error and makes no file", async () => {
  const loc = await location();
  await parent(loc);
  const first = await forkAtTurn(loc, FORK, 1, deps());
  expect(first.copied).toBe(2);
  const other = { ...loc, session: "01J0000000000000000000000C" };
  await expect(forkAtTurn(loc, other.session, 9, deps())).rejects.toThrow("turn 9");
  await expect(readFile(sessionPaths(other).log)).rejects.toThrow();
});

// spec: AC-CKPT-12
test("the fork resumes with the earlier turns, is the newest session, and still works when the parent's files are gone", async () => {
  const loc = await location();
  await parent(loc);
  await forkAtTurn(loc, FORK, 3, deps());

  const sessions = await listSessions(loc);
  expect(sessions.map((s) => s.id)).toEqual([PARENT, FORK]);

  const parentPaths = sessionPaths(loc);
  await rm(parentPaths.log);
  await rm(parentPaths.meta, { force: true });
  const resumed = await resumeSession({ ...loc, session: FORK });
  expect(resumed.readOnly).toBeUndefined();
  expect(resumed.state.turn).toBe(2);
  const read = await readSession({ ...loc, session: FORK });
  expect(UserMessageData.parse(read.events[2]?.data).text).toStartWith("first 😀 xxx");
});

// spec: AC-CKPT-12
test("a prompt sent right after a rewind is in the fork's log before any turn ends, and survives SIGKILL", async () => {
  const loc = await location();
  await parent(loc);
  await forkAtTurn(loc, FORK, 3, deps());
  await mkdir(join(loc.data), { recursive: true });

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../../test/fixtures/fork/prompt-child.ts"),
      loc.data,
      loc.projectRoot,
      FORK,
      OS,
      "typed right after the rewind",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  const seen = await Promise.race([
    reader.read().then((r) => new TextDecoder().decode(r.value)),
    Bun.sleep(20_000).then(() => "timeout"),
  ]);
  child.kill("SIGKILL");
  await child.exited;
  expect(seen.trim()).toBe("READY");

  const read = await readSession({ ...loc, session: FORK });
  expect(read.events.at(-1)?.type).toBe("user.message");
  expect(UserMessageData.parse(read.events.at(-1)?.data).text).toBe("typed right after the rewind");
}, 30_000);
