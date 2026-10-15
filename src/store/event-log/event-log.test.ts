import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeClock, sequentialIds, type TempProject, tempProject } from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import { Secret } from "../secrets/index.ts";
import {
  checkDataPermissions,
  listSessions,
  openSession,
  readSession,
  type SessionLocation,
  secretValuesFromEnv,
  sessionPaths,
} from "./index.ts";

const OS: Os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const POSIX = OS !== "win32";
const SESSION = "01J0000000000000000000000A";

let dir: TempProject | undefined;
afterEach(async () => {
  await dir?.dispose();
  dir = undefined;
});

async function location(session = SESSION): Promise<SessionLocation> {
  dir ??= await tempProject({ "proj/README.md": "x" });
  return { data: join(dir.root, "data"), projectRoot: join(dir.root, "proj"), os: OS, session };
}

async function open(loc: SessionLocation, extra: { secrets?: string[]; flushMs?: number; seed?: string } = {}) {
  const r = await openSession({
    ...loc,
    clock: fakeClock(Date.UTC(2026, 9, 13)),
    ids: sequentialIds(extra.seed ?? "1"),
    pid: 4242,
    host: "test-host",
    secrets: extra.secrets ?? [],
    flushMs: extra.flushMs ?? 60_000,
  });
  if (r.mode !== "write") throw new Error(`expected a writer, got read-only: ${r.reason}`);
  return r.writer;
}

describe("writer", () => {
  test("appends one JSON line per event, buffered until turn.end, with U+2028 and U+2029 escaped", async () => {
    const loc = await location();
    const w = await open(loc);
    w.append({ type: "session.start", epoch: 0, turn: null, data: { cwd: "/p" } });
    w.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "line\u2028sep\u2029para" } });
    const { log } = sessionPaths(loc);
    expect(await Bun.file(log).text()).toBe("");
    w.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
    await w.flush();
    const text = await readFile(log, "utf8");
    expect(text).not.toMatch(/[\u2028\u2029]/);
    expect(text).toContain("\\u2028");
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).map((l) => JSON.parse(l).type)).toEqual(["session.start", "user.message", "turn.end"]);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ v: 1, session: SESSION, epoch: 0, turn: 1, core: true });
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({ core: false });
    await w.close();
  });

  test("flushes on a timer while streaming", async () => {
    const loc = await location();
    const w = await open(loc, { flushMs: 10 });
    w.append({ type: "session.start", epoch: 0, turn: null, data: {} });
    await Bun.sleep(50);
    expect(await Bun.file(sessionPaths(loc).log).text()).toContain("session.start");
    await w.close();
  });

  test("an event type Dovet doesn't know is a bug, not a line in the log", async () => {
    const w = await open(await location());
    // @ts-expect-error: the type check is the first guard; this tests the second, for data from outside TypeScript
    expect(() => w.append({ type: "made.up", epoch: 0, turn: null, data: {} })).toThrow("made.up");
    await w.close();
  });

  test("reopening a session appends after the earlier lines and continues its metadata", async () => {
    const loc = await location();
    const first = await open(loc);
    first.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "first title" } });
    first.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
    await first.close();
    const { log, meta } = sessionPaths(loc);
    const before = await readFile(log, "utf8");
    const second = await open(loc, { seed: "2" });
    second.append({ type: "user.message", epoch: 0, turn: 2, data: { text: "second" } });
    second.append({ type: "turn.end", epoch: 0, turn: 2, data: { reason: "end_turn" } });
    await second.close();
    expect((await readFile(log, "utf8")).startsWith(before)).toBe(true);
    const sidecar = JSON.parse(await readFile(meta, "utf8"));
    expect(sidecar).toMatchObject({ title: "first title", turns: 2 });
    await rm(meta);
    expect((await listSessions(loc))[0]).toEqual(sidecar);
  });

  // spec: AC-LOG-01
  test("reopening after a crash mid-line repairs the log without rewriting it, and it stays writable", async () => {
    const loc = await location();
    const first = await open(loc);
    first.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
    await first.close();
    const { log } = sessionPaths(loc);
    await writeFile(log, `${await readFile(log, "utf8")}{"v":1,"id":"01J`);
    const torn = await readFile(log, "utf8");
    const second = await open(loc, { seed: "2" });
    second.append({ type: "turn.end", epoch: 0, turn: 2, data: { reason: "end_turn" } });
    await second.close();
    expect((await readFile(log, "utf8")).startsWith(torn)).toBe(true);
    const r = await readSession(loc);
    expect(r.readOnly).toBeUndefined();
    expect(r.warnings).toEqual(["line 2: ignored an incomplete line (Dovet stopped while writing it)"]);
    expect(r.events.map((e) => e.type)).toEqual(["turn.end", "session.resume", "turn.end"]);
    expect(r.events[1]?.data).toEqual({ reason: "crash-repair", tornLine: 2 });
  });

  test("a permission request reaches the disk without an explicit flush", async () => {
    const loc = await location();
    const w = await open(loc);
    w.append({ type: "permission.request", epoch: 0, turn: 1, data: { kind: "tool" } });
    await Bun.sleep(20);
    expect(await Bun.file(sessionPaths(loc).log).text()).toContain("permission.request");
    await w.close();
  });

  test("the lock heartbeat advances its mtime, and stops the writer if another process took the lock", async () => {
    const loc = await location();
    const { lock } = sessionPaths(loc);
    const r = await openSession({
      ...loc,
      clock: fakeClock(),
      ids: sequentialIds("1"),
      pid: 1,
      host: "h",
      secrets: [],
      heartbeatMs: 10,
    });
    if (r.mode !== "write") throw new Error(r.reason);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await Bun.sleep(50);
    expect((await stat(lock)).mtimeMs).toBeGreaterThan(old.getTime() + 30_000);
    await writeFile(lock, JSON.stringify({ pid: 9, host: "other" }));
    await Bun.sleep(50);
    expect(() => r.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: {} })).toThrow(
      "another Dovet process took over",
    );
    await expect(r.writer.close()).rejects.toThrow("took over");
    expect(await readFile(lock, "utf8")).toContain('"pid":9');
  });

  test("ids must increase, an event over 1 MB is refused, and a closed writer takes nothing", async () => {
    const loc = await location();
    const r = await openSession({
      ...loc,
      clock: fakeClock(),
      ids: { ulid: () => "01J0000000000000000000000Z" },
      pid: 1,
      host: "h",
      secrets: [],
    });
    if (r.mode !== "write") throw new Error(r.reason);
    r.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: {} });
    expect(() => r.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: {} })).toThrow("is not after");
    await r.writer.close();
    expect(() => r.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: {} })).toThrow("closed");
    const w = await open({ ...loc, session: "01J0000000000000000000000C" });
    const parts = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(200 * 1024));
    expect(() => w.append({ type: "tool.call", epoch: 0, turn: 1, data: { parts } })).toThrow("over 1 MB");
    await w.close();
  });

  test("data that only looks like a blob reference is kept as data", async () => {
    const loc = await location();
    const w = await open(loc);
    const lookalike = { $blob: "b".repeat(64), bytes: 3 };
    w.append({ type: "tool.call", epoch: 0, turn: 1, data: { input: lookalike, other: { $lit: 1 } } });
    await w.close();
    const r = await readSession(loc);
    expect(r.readOnly).toBeUndefined();
    expect(r.events[0]?.data).toEqual({ input: lookalike, other: { $lit: 1 } });
  });

  // spec: AC-LOG-04
  test("a second process opening the same session gets read-only mode and the reason", async () => {
    const loc = await location();
    const w = await open(loc);
    const script = `
      import { openSession } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
      const r = await openSession({ ...${JSON.stringify(loc)}, clock: { now: () => Date.now() },
        ids: { ulid: () => "01J0000000000000000000000B" }, pid: process.pid, host: "other", secrets: [] });
      console.log(JSON.stringify(r.mode === "write" ? { mode: "write" } : r));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script]);
    expect(child.stderr.toString()).toBe("");
    const result = JSON.parse(child.stdout.toString());
    expect(result.mode).toBe("read-only");
    expect(result.reason).toContain("open in another Dovet process (pid 4242 on test-host)");
    await w.close();
    const again = await openSession({
      ...loc,
      clock: fakeClock(),
      ids: sequentialIds("2"),
      pid: 1,
      host: "h",
      secrets: [],
    });
    expect(again.mode).toBe("write");
    if (again.mode === "write") await again.writer.close();
  });

  // spec: AC-LOG-04
  test("a lock whose heartbeat stopped more than 2 minutes ago is taken over", async () => {
    const loc = await location();
    const { lock } = sessionPaths(loc);
    const first = await open(loc);
    const old = new Date(Date.now() - 3 * 60_000);
    await utimes(lock, old, old);
    const second = await openSession({
      ...loc,
      clock: fakeClock(),
      ids: sequentialIds("2"),
      pid: 7,
      host: "h",
      secrets: [],
    });
    expect(second.mode).toBe("write");
    expect(await readFile(lock, "utf8")).toContain('"pid":7');
    if (second.mode === "write") await second.writer.close();
    await first.close();
  });

  // spec: AC-LOG-06
  test("no secret from the env or config reaches the log", async () => {
    const env = {
      NVIDIA_API_KEY: "nvapi-FAKE-ENV-SECRET-0001",
      GITHUB_TOKEN: "ghp_FAKEFAKEFAKEFAKE0002",
      DB_PASSWORD: "hunter2-FAKE-0003",
      HOME: "/home/someone",
      SHORT_KEY: "abc",
      GIT_AUTHOR_NAME: "Someone Writing Code",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.socket",
    };
    const configKey = "nvapi-FAKE-CONFIG-SECRET-0004";
    const loc = await location();
    const w = await open(loc, { secrets: [...secretValuesFromEnv(env), configKey] });
    w.append({
      type: "session.start",
      epoch: 0,
      turn: null,
      data: { config: { providers: { nvidia: { apiKey: new Secret(configKey) } } }, env },
    });
    w.append({
      type: "tool.result",
      epoch: 0,
      turn: 1,
      data: { output: `$ env\nGITHUB_TOKEN=${env.GITHUB_TOKEN}\n${configKey}` },
    });
    w.append({ type: "user.message", epoch: 0, turn: 1, data: { text: `my password is ${env.DB_PASSWORD}` } });
    const big = `${"x".repeat(300 * 1024)}${env.NVIDIA_API_KEY}`;
    w.append({ type: "tool.result", epoch: 0, turn: 1, data: { output: big } });
    await w.close();
    const blobDir = join(loc.data, "blobs");
    for (const sub of await readdir(blobDir)) {
      for (const f of await readdir(join(blobDir, sub))) {
        expect(await readFile(join(blobDir, sub, f), "utf8")).not.toContain(env.NVIDIA_API_KEY);
      }
    }
    const text = await readFile(sessionPaths(loc).log, "utf8");
    for (const s of [env.NVIDIA_API_KEY, env.GITHUB_TOKEN, env.DB_PASSWORD, configKey]) expect(text).not.toContain(s);
    expect(text).toContain("/home/someone");
    expect(text).toContain("Someone Writing Code");
    expect(text).toContain("/tmp/ssh-agent.socket");
    expect(text).toContain("[redacted]");
  });

  // spec: AC-LOG-07
  test("a 3 MB Write stores its content as an essential blob and reads back identically", async () => {
    const loc = await location();
    const w = await open(loc);
    const content = "const x = 1;\n".repeat(Math.ceil((3 * 1024 * 1024) / 13));
    const input = { file_path: "/p/big.ts", content };
    w.append({ type: "tool.call", epoch: 0, turn: 1, data: { id: "c1", name: "Write", input } });
    await w.close();
    const line = (await readFile(sessionPaths(loc).log, "utf8")).split("\n")[0] ?? "";
    expect(line.length).toBeLessThan(1024 * 1024);
    const ref = JSON.parse(line).data.input.content;
    expect(ref).toEqual({ $blob: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: Buffer.byteLength(content) });
    expect(await stat(join(loc.data, "blobs", ref.$blob.slice(0, 2), ref.$blob)).then((s) => s.size)).toBe(ref.bytes);
    const read = await readSession(loc);
    expect(read.readOnly).toBeUndefined();
    expect(read.events[0]?.data).toEqual({ id: "c1", name: "Write", input });
  });

  // spec: AC-LOG-08
  test.if(POSIX)("data dirs are 0700 and files 0600, and loosened permissions are reported", async () => {
    const loc = await location();
    const w = await open(loc);
    w.append({ type: "tool.call", epoch: 0, turn: 1, data: { content: "y".repeat(300 * 1024) } });
    w.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
    await w.flush();
    const paths = sessionPaths(loc);
    const dirs = [loc.data, join(loc.data, "projects"), paths.dir, join(loc.data, "blobs")];
    for (const d of dirs) expect({ d, mode: (await stat(d)).mode & 0o777 }).toEqual({ d, mode: 0o700 });
    const blobDir = join(loc.data, "blobs", ...(await readdir(join(loc.data, "blobs"))).slice(0, 1));
    const blob = join(blobDir, (await readdir(blobDir))[0] ?? "");
    for (const f of [paths.log, paths.lock, paths.meta, blob]) {
      expect({ f, mode: (await stat(f)).mode & 0o777 }).toEqual({ f, mode: 0o600 });
    }
    expect(await checkDataPermissions(loc)).toEqual([]);
    await chmod(loc.data, 0o750);
    await chmod(paths.log, 0o640);
    const warnings = await checkDataPermissions(loc);
    expect(warnings).toEqual([
      expect.stringContaining(`${loc.data} can be read by other users`),
      expect.stringContaining(`${paths.log} can be read by other users`),
    ]);
    await w.close();
  });
});

describe("reader", () => {
  async function plant(lines: string[]): Promise<SessionLocation> {
    const loc = await location();
    const w = await open(loc);
    await w.close();
    await writeFile(sessionPaths(loc).log, lines.join("\n"));
    return loc;
  }

  const ev = (n: number, type: string, core: boolean, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      id: `01J00000000000000000000${String(n).padStart(3, "0")}`,
      ts: "2026-10-13T00:00:00.000Z",
      session: SESSION,
      epoch: 0,
      turn: 1,
      type,
      core,
      data: {},
      ...extra,
    });

  // spec: AC-LOG-09
  test("an unknown core event opens the session read-only with the reason", async () => {
    const loc = await plant([ev(1, "session.start", true), ev(2, "future.thing", true), ev(3, "turn.end", false), ""]);
    const r = await readSession(loc);
    expect(r.readOnly).toBe('line 2: unknown core event type "future.thing" (written by a newer Dovet?)');
    expect(r.events.map((e) => e.type)).toEqual(["session.start"]);
  });

  // spec: AC-LOG-09
  test("an unknown optional event is skipped with a warning", async () => {
    const loc = await plant([ev(1, "session.start", true), ev(2, "future.note", false), ev(3, "turn.end", false), ""]);
    const r = await readSession(loc);
    expect(r.readOnly).toBeUndefined();
    expect(r.warnings).toEqual(['line 2: skipped unknown optional event type "future.note"']);
    expect(r.events.map((e) => e.type)).toEqual(["session.start", "turn.end"]);
  });

  test("a known event with the wrong core flag opens read-only", async () => {
    const r = await readSession(await plant([ev(1, "turn.end", true), ""]));
    expect(r.readOnly).toBe('line 1: event type "turn.end" has the wrong core flag');
  });

  test("an unsupported schema version opens read-only", async () => {
    const r = await readSession(await plant([ev(1, "session.start", true, { v: 2 }), ""]));
    expect(r.readOnly).toBe("line 1: unsupported event schema version 2");
  });

  test("a partial final line is ignored and reported; a bad line elsewhere is corruption", async () => {
    const partial = await readSession(await plant([ev(1, "session.start", true), '{"v":1,"id":"01J']));
    expect(partial.readOnly).toBeUndefined();
    expect(partial.events).toHaveLength(1);
    expect(partial.warnings).toEqual(["line 2: ignored an incomplete last line (Dovet stopped while writing it)"]);
    await dir?.dispose();
    dir = undefined;
    const corrupt = await readSession(
      await plant([ev(1, "session.start", true), "not json", ev(3, "turn.end", false), ""]),
    );
    expect(corrupt.readOnly).toBe("line 2: the line is not valid JSON");
    expect(corrupt.events).toHaveLength(1);
  });

  test("a missing essential blob opens read-only and names it", async () => {
    const sha = "a".repeat(64);
    const r = await readSession(
      await plant([ev(1, "tool.call", true, { data: { content: { $blob: sha, bytes: 5 } } }), ""]),
    );
    expect(r.readOnly).toBe(`line 1: essential blob ${sha} is missing`);
  });
});

describe("session list", () => {
  // spec: AC-LOG-05
  test("deleting every .meta.json rebuilds identical metadata from the logs", async () => {
    const first = await location("01J0000000000000000000000A");
    const second = { ...first, session: "01J0000000000000000000000B" };
    for (const [loc, seed, text] of [
      [first, "1", "Fix the failing test in src/app.ts and explain why it broke in the first place please"],
      [second, "2", "hi"],
    ] as const) {
      const w = await open(loc, { seed });
      w.append({ type: "session.start", epoch: 0, turn: null, data: {} });
      for (const turn of [1, 2]) {
        w.append({ type: "user.message", epoch: 0, turn, data: { text: turn === 1 ? text : "next" } });
        w.append({ type: "turn.end", epoch: 0, turn, data: { reason: "end_turn" } });
      }
      await w.close();
    }
    const before = await listSessions(first);
    expect(before.map((m) => [m.id, m.title, m.turns])).toEqual([
      ["01J0000000000000000000000A", "Fix the failing test in src/app.ts and explain why it broke", 2],
      ["01J0000000000000000000000B", "hi", 2],
    ]);
    await rm(sessionPaths(first).meta);
    await rm(sessionPaths(second).meta);
    expect(await listSessions(first)).toEqual(before);
  });

  test("a sidecar older than its log is rebuilt", async () => {
    const loc = await location();
    const w = await open(loc);
    w.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "one" } });
    w.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
    await w.close();
    expect((await listSessions(loc))[0]?.turns).toBe(1);
    const { log } = sessionPaths(loc);
    const lines = (await readFile(log, "utf8")).split("\n");
    const again = JSON.parse(lines[1] ?? "");
    await writeFile(
      log,
      `${lines.join("\n")}${JSON.stringify({ ...again, id: "01J00000000000000000000ZZZ", turn: 2 })}\n`,
    );
    expect((await listSessions(loc))[0]).toMatchObject({ id: SESSION, title: "one", turns: 2 });
  });
});
