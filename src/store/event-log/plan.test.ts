// The plan file across forks and resume (tools §11.1; QUESTIONS Q85).
import { afterEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fakeClock, sequentialIds, type TempProject, tempProject } from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import type { EventType } from "../../schema/index.ts";
import { forkAtTurn } from "./fork.ts";
import { forkSession, openSession, readSession, resumeSession, type SessionLocation } from "./index.ts";
import { planDir } from "./paths.ts";

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

/** Three turns in plan mode; the plan file is named after turn 1's message. */
async function parent(loc: SessionLocation, planFile: string): Promise<void> {
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
  const add = (type: EventType, turn: number | null, data: unknown): void => {
    r.writer.append({ type, epoch: 0, turn, data });
  };
  add("session.start", null, { mode: "plan" });
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
  add("settings.change", null, { key: "planFile", new: planFile, source: "plan" });
  for (let turn = 1; turn <= 3; turn++) {
    add("user.message", turn, { text: `task ${turn}` });
    add("turn.end", turn, { reason: "end_turn" });
  }
  await r.writer.close();
}

const planOf = async (loc: SessionLocation): Promise<string | null> => (await resumeSession(loc)).state.planFile;

// spec: tools §11.1
test("resume gives the latest plan file, and null once it was cleared", async () => {
  const loc = await location();
  await parent(loc, join(planDir(loc), "plan-aaaa.md"));
  expect(await planOf(loc)).toBe(join(planDir(loc), "plan-aaaa.md"));
  const r = await openSession({
    ...loc,
    clock: fakeClock(Date.UTC(2026, 9, 15)),
    ids: sequentialIds("2"),
    pid: 1,
    host: "h",
    secrets: [],
  });
  if (r.mode !== "write") throw new Error(r.reason);
  r.writer.append({
    type: "settings.change",
    epoch: 0,
    turn: null,
    data: { key: "planFile", old: "x", new: null, source: "clear" },
  });
  await r.writer.close();
  expect(await planOf(loc)).toBeNull();
});

// spec: tools §11.1
test("a fork gets its own copy of the plan, and editing either leaves the other alone", async () => {
  const loc = await location();
  const parentPlan = join(planDir(loc), "refactor-the-parser-aaaa.md");
  await parent(loc, parentPlan);
  await mkdir(dirname(parentPlan), { recursive: true });
  await writeFile(parentPlan, "1. read\n2. change\n");

  await forkAtTurn(loc, FORK, 3, deps());

  const forkLoc = { ...loc, session: FORK };
  const copy = await planOf(forkLoc);
  expect(copy).toBe(join(planDir(forkLoc), "refactor-the-parser-aaaa.md"));
  expect(copy).not.toBe(parentPlan);
  expect(await readFile(copy ?? "", "utf8")).toBe("1. read\n2. change\n");
  await writeFile(copy ?? "", "forked plan");
  await writeFile(parentPlan, "parent plan");
  expect(await readFile(parentPlan, "utf8")).toBe("parent plan");
  expect(await readFile(copy ?? "", "utf8")).toBe("forked plan");
  expect(await planOf(loc)).toBe(parentPlan);
  expect((await resumeSession(forkLoc)).state.mode).toBe("plan");
});

// spec: tools §11.1
test("a plan under the project (plan.directory) is copied beside the original under a name of the fork's own", async () => {
  const loc = await location();
  const parentPlan = join(loc.projectRoot, "plans", "fix-bug-aaaa.md");
  await parent(loc, parentPlan);
  await mkdir(dirname(parentPlan), { recursive: true });
  await writeFile(parentPlan, "project plan");

  await forkAtTurn(loc, FORK, 2, deps());

  const copy = await planOf({ ...loc, session: FORK });
  expect(copy).toBe(join(loc.projectRoot, "plans", "fix-bug-aaaa-000b.md"));
  expect(await readFile(copy ?? "", "utf8")).toBe("project plan");
  expect((await readdir(join(loc.projectRoot, "plans"))).sort()).toEqual(["fix-bug-aaaa-000b.md", "fix-bug-aaaa.md"]);
});

// spec: tools §11.1
test("a plan that was never written is still re-pointed, and nothing is copied or fails", async () => {
  const loc = await location();
  const parentPlan = join(planDir(loc), "never-aaaa.md");
  await parent(loc, parentPlan);
  await forkAtTurn(loc, FORK, 3, deps());
  const copy = await planOf({ ...loc, session: FORK });
  expect(copy).toBe(join(planDir({ ...loc, session: FORK }), "never-aaaa.md"));
  await expect(readFile(copy ?? "", "utf8")).rejects.toThrow();
});

// spec: tools §11.1
test("a session without a plan forks without any plan event", async () => {
  const loc = await location();
  await parent(loc, join(planDir(loc), "x.md"));
  const log = (await readSession(loc)).events.filter((e) => e.type !== "settings.change");
  expect(log.length).toBeGreaterThan(0);
  const noPlan = { ...loc, session: "01J0000000000000000000000C" };
  const r = await openSession({
    ...noPlan,
    clock: fakeClock(Date.UTC(2026, 9, 13)),
    ids: sequentialIds("3"),
    pid: 1,
    host: "h",
    secrets: [],
  });
  if (r.mode !== "write") throw new Error(r.reason);
  r.writer.append({ type: "session.start", epoch: 0, turn: null, data: { mode: "default" } });
  r.writer.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "a" } });
  r.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
  r.writer.append({ type: "user.message", epoch: 0, turn: 2, data: { text: "b" } });
  await r.writer.close();
  await forkAtTurn(noPlan, FORK, 2, deps());
  const types = (await readSession({ ...noPlan, session: FORK })).events.map((e) => e.type);
  expect(types).not.toContain("settings.change");
});

// spec: tools §11.1
test("a crash-repair fork carries the plan too", async () => {
  const loc = await location();
  const parentPlan = join(planDir(loc), "repair-aaaa.md");
  await parent(loc, parentPlan);
  await mkdir(dirname(parentPlan), { recursive: true });
  await writeFile(parentPlan, "repair plan");
  await forkSession(loc, FORK, 2, deps());
  const copy = await planOf({ ...loc, session: FORK });
  expect(copy).toBe(join(planDir({ ...loc, session: FORK }), "repair-aaaa.md"));
  expect(await readFile(copy ?? "", "utf8")).toBe("repair plan");
});
