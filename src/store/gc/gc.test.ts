// Garbage collection of the data directory (event-log "Blob store", "Disk use").
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobStore } from "../blobs/index.ts";
import { rewindExpired } from "../event-log/index.ts";
import { type GcInput, type GcSettings, runGc } from "./index.ts";

const DAY = 86_400_000;
const NOW = Date.now();
const SETTINGS: GcSettings = { days: 30, deleteSessions: false, outputsDays: 7 };
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function world(): Promise<World> {
  const data = await realpath(await mkdtemp(join(tmpdir(), "dovet-tool-gc-")));
  roots.push(data);
  return new World(data);
}

function age(path: string, days: number): void {
  const when = new Date(NOW - days * DAY);
  utimesSync(path, when, when);
}

class World {
  readonly blobs;
  constructor(readonly data: string) {
    this.blobs = createBlobStore(data);
  }

  blob(text: string, days = 40): string {
    const sha = this.blobs.putSync(new TextEncoder().encode(text));
    age(join(this.data, "blobs", sha.slice(0, 2), sha), days);
    return sha;
  }

  blobPath(sha: string): string {
    return join(this.data, "blobs", sha.slice(0, 2), sha);
  }

  sessionsDir(project: string): string {
    const dir = join(this.data, "projects", project, "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A session log whose last write was `days` ago. `events` are [type, data] pairs. */
  session(
    project: string,
    id: string,
    events: [string, unknown][],
    days: number,
    extra: { lock?: boolean } = {},
  ): string {
    const dir = this.sessionsDir(project);
    const log = join(dir, `${id}.jsonl`);
    const text = events
      .map(([type, data], i) =>
        JSON.stringify({
          v: 1,
          id: `${id}-${i}`,
          ts: "2026-01-01T00:00:00.000Z",
          session: id,
          epoch: 0,
          turn: 1,
          type,
          core: true,
          data,
        }),
      )
      .join("\n");
    writeFileSync(log, `${text}\n`);
    age(log, days);
    if (extra.lock) writeFileSync(join(dir, `${id}.lock`), JSON.stringify({ pid: 1, host: "h" }));
    return log;
  }

  offload(project: string, id: string, name: string, days: number, kind = "outputs"): string {
    const dir = join(this.sessionsDir(project), id, kind);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "full output");
    age(path, days);
    return path;
  }

  gc(over: Partial<Omit<GcInput, "settings">> & { settings?: Partial<GcSettings> } = {}) {
    const { settings, ...rest } = over;
    return runGc({ data: this.data, now: NOW, env: {}, graceMs: 0, ...rest, settings: { ...SETTINGS, ...settings } });
  }
}

const attach = (sha: string) =>
  ["user.message", { text: "see", attachments: [{ store: "blob", id: sha }] }] as [string, unknown];
const beforeOf = (sha: string) =>
  ["checkpoint", { id: "c1", turn: 1, mechanism: "blobs", files: [{ path: "a.txt", before: sha }] }] as [
    string,
    unknown,
  ];

describe("blob classes", () => {
  // spec: AC-LOG-10
  test("an essential blob any retained log references survives, wherever that log is and however old", async () => {
    const w = await world();
    const attachment = w.blob("image bytes");
    const bigWrite = w.blob("a 3 MB Write");
    const orphan = w.blob("nobody wants this");
    w.session("p1", "old", [attach(attachment)], 400);
    w.session("p2", "other", [["tool.call", { input: { content: { $blob: bigWrite, bytes: 12 } } }]], 1);

    const report = await w.gc();

    expect(existsSync(w.blobPath(attachment))).toBe(true);
    expect(existsSync(w.blobPath(bigWrite))).toBe(true);
    expect(existsSync(w.blobPath(orphan))).toBe(false);
    expect(report.blobsRemoved).toBe(1);
    expect(report.bytesFreed).toBe("nobody wants this".length);
  });

  // spec: AC-LOG-10
  test("a $blob reference is found whatever the key order, and in a line that does not parse", async () => {
    const w = await world();
    const a = w.blob("a");
    const b = w.blob("b");
    const dir = w.sessionsDir("p1");
    writeFileSync(
      join(dir, "s.jsonl"),
      `{"data":{"x":{"bytes":1,"$blob":"${a}"}},"type":"tool.call"}\n{"type":"tool.call","data":{"x":{"$blob":"${b}"\n`,
    );
    await w.gc();
    expect(existsSync(w.blobPath(a))).toBe(true);
    expect(existsSync(w.blobPath(b))).toBe(true);
  });

  // spec: AC-LOG-10
  test("rewind-only data is removed once its session is older than retention.days, unless a retained session still references it", async () => {
    const w = await world();
    const mine = w.blob("old before bytes");
    const shared = w.blob("fork shares this");
    const fresh = w.blob("fresh before bytes", 1);
    w.session("p1", "expired", [beforeOf(mine), beforeOf(shared)], 45);
    w.session(
      "p1",
      "fork",
      [beforeOf(shared), ["file.change", { path: "a", op: "modify", added: 1, removed: 0, before: fresh }]],
      2,
    );

    await w.gc();

    expect(existsSync(w.blobPath(mine))).toBe(false);
    expect(existsSync(w.blobPath(shared))).toBe(true);
    expect(existsSync(w.blobPath(fresh))).toBe(true);
  });

  // spec: AC-LOG-10
  test("a blob both essential and rewind-only stays when the rewind session expires", async () => {
    const w = await world();
    const both = w.blob("pasted file");
    w.session("p1", "s", [attach(both), beforeOf(both)], 45);
    await w.gc();
    expect(existsSync(w.blobPath(both))).toBe(true);
  });

  // spec: AC-LOG-10
  test("the sidecar records when rewind data expires, and expired sessions say so", async () => {
    const w = await world();
    w.session("p1", "old", [["user.message", { text: "hi" }]], 45);
    w.session("p1", "new", [["user.message", { text: "hi" }]], 2);
    const dir = w.sessionsDir("p1");
    for (const id of ["old", "new"]) {
      writeFileSync(
        join(dir, `${id}.meta.json`),
        JSON.stringify({
          id,
          title: "",
          created: "",
          updated: "",
          turns: 0,
          lastId: "",
          bytes: statSync(join(dir, `${id}.jsonl`)).size,
        }),
      );
    }

    await w.gc();

    const old = JSON.parse(await readFile(join(dir, "old.meta.json"), "utf8")) as {
      rewindAvailableUntil: string;
      bytes: number;
    };
    const fresh = JSON.parse(await readFile(join(dir, "new.meta.json"), "utf8")) as { rewindAvailableUntil: string };
    expect(Date.parse(old.rewindAvailableUntil)).toBe(statSync(join(dir, "old.jsonl")).mtimeMs + 30 * DAY);
    expect(rewindExpired(old, NOW)).toBe(true);
    expect(rewindExpired(fresh, NOW)).toBe(false);
    expect(old.bytes).toBe(statSync(join(dir, "old.jsonl")).size);
  });

  test("storing a blob that already exists refreshes its age, so a session about to log it can't lose it to GC", async () => {
    const w = await world();
    const sha = w.blob("same image attached again");
    expect(w.blobs.putSync(new TextEncoder().encode("same image attached again"))).toBe(sha);
    await w.gc({ graceMs: 3_600_000 });
    expect(existsSync(w.blobPath(sha))).toBe(true);
  });

  test("a blob written moments ago, before its event was logged, is left alone", async () => {
    const w = await world();
    const young = w.blob("in flight", 0);
    await w.gc({ graceMs: 3_600_000 });
    expect(existsSync(w.blobPath(young))).toBe(true);
  });
});

describe("active sessions and the GC lock", () => {
  test("a session whose lock heartbeat is fresh is never collected under", async () => {
    const w = await world();
    const mine = w.blob("rewind bytes of the live session");
    const log = w.session("p1", "live", [beforeOf(mine)], 90, { lock: true });
    writeFileSync(join(w.sessionsDir("p1"), "live.lock"), "x"); // fresh mtime: heartbeat just touched it
    const out = w.offload("p1", "live", "c1.txt", 20);

    const report = await w.gc({ settings: { deleteSessions: true } });

    expect(existsSync(log)).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(w.blobPath(mine))).toBe(true);
    expect(report.sessionsDeleted).toEqual([]);
  });

  test("a stale lock does not protect a session", async () => {
    const w = await world();
    const log = w.session("p1", "dead", [["user.message", { text: "x" }]], 90, { lock: true });
    age(join(w.sessionsDir("p1"), "dead.lock"), 1);
    await w.gc({ settings: { deleteSessions: true } });
    expect(existsSync(log)).toBe(false);
  });

  test("a second GC while one holds a fresh lock does nothing; a stale GC lock is taken over", async () => {
    const w = await world();
    const orphan = w.blob("orphan");
    writeFileSync(join(w.data, "gc.lock"), "other");
    const skipped = await w.gc();
    expect(skipped.skipped).toMatch(/already running/);
    expect(existsSync(w.blobPath(orphan))).toBe(true);

    age(join(w.data, "gc.lock"), 1);
    const ran = await w.gc();
    expect(ran.skipped).toBeUndefined();
    expect(existsSync(w.blobPath(orphan))).toBe(false);
    expect(existsSync(join(w.data, "gc.lock"))).toBe(false);
  });
});

describe("retention.deleteSessions", () => {
  test("deletes sessions older than retention.days with their sidecar, offload, snapshot cache and unreferenced blobs", async () => {
    const w = await world();
    const only = w.blob("only the old session has it");
    const kept = w.blob("a younger session has it too");
    const log = w.session("p1", "old", [attach(only), attach(kept)], 45);
    const dir = w.sessionsDir("p1");
    for (const ext of ["meta.json", "snap.stat", "snap.index"]) writeFileSync(join(dir, `old.${ext}`), "x");
    const out = w.offload("p1", "old", "c1.txt", 1);
    w.session("p1", "young", [attach(kept)], 3);

    const report = await w.gc({ settings: { deleteSessions: true } });

    expect(report.sessionsDeleted).toEqual(["old"]);
    expect(readdirSync(dir).filter((n) => n.startsWith("old"))).toEqual([]);
    expect(existsSync(log) || existsSync(out)).toBe(false);
    expect(existsSync(w.blobPath(only))).toBe(false);
    expect(existsSync(w.blobPath(kept))).toBe(true);
  });

  test("keeps old sessions when the setting is off", async () => {
    const w = await world();
    const log = w.session("p1", "old", [["user.message", { text: "x" }]], 400);
    await w.gc();
    expect(existsSync(log)).toBe(true);
  });
});

describe("offload files", () => {
  // spec: AC-LOG-14
  test("offload files and debug request bodies older than retention.outputsDays are removed, newer ones stay", async () => {
    const w = await world();
    w.session("p1", "s", [["user.message", { text: "x" }]], 1);
    const oldOut = w.offload("p1", "s", "c1.txt", 10);
    const newOut = w.offload("p1", "s", "c2.txt", 2);
    const oldReq = w.offload("p1", "s", "e1.json", 10, "requests");

    const report = await w.gc();

    expect(existsSync(oldOut)).toBe(false);
    expect(existsSync(oldReq)).toBe(false);
    expect(existsSync(newOut)).toBe(true);
    expect(report.offloadRemoved).toBe(2);
  });

  test("outputsDays comes from the settings", async () => {
    const w = await world();
    w.session("p1", "s", [["user.message", { text: "x" }]], 1);
    const out = w.offload("p1", "s", "c1.txt", 10);
    await w.gc({ settings: { outputsDays: 30 } });
    expect(existsSync(out)).toBe(true);
  });

  test("an abort stops the run between steps and releases the lock", async () => {
    const w = await world();
    const orphan = w.blob("orphan");
    const stop = new AbortController();
    stop.abort();
    const report = await w.gc({ signal: stop.signal });
    expect(report.skipped).toMatch(/stopped/);
    expect(existsSync(w.blobPath(orphan))).toBe(true);
    expect(existsSync(join(w.data, "gc.lock"))).toBe(false);
  });
});
