// Disk use and stored-session management (event-log "Disk use").
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataSize, deleteStored, listStored, parseSize, sizeWarning } from "./index.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 12);
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function data(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dovet-tool-usage-")));
  roots.push(dir);
  return dir;
}

function session(dir: string, project: string, id: string, bytes: number, days: number, lock = false): void {
  const sessions = join(dir, "projects", project, "sessions");
  mkdirSync(join(sessions, id, "outputs"), { recursive: true });
  const log = join(sessions, `${id}.jsonl`);
  writeFileSync(log, "x".repeat(bytes));
  writeFileSync(join(sessions, `${id}.meta.json`), "{}");
  writeFileSync(join(sessions, id, "outputs", "c1.txt"), "y".repeat(10));
  const when = new Date(NOW - days * DAY);
  utimesSync(log, when, when);
  if (lock) {
    writeFileSync(join(sessions, `${id}.lock`), "{}");
    utimesSync(join(sessions, `${id}.lock`), new Date(NOW - 1000), new Date(NOW - 1000));
  }
}

describe("data size warning", () => {
  // spec: AC-LOG-14
  test("warns when the data directory is over retention.warnAtGB, names the largest sessions and the commands, once a day", async () => {
    const dir = await data();
    session(dir, "p1", "SMALL", 100, 1);
    session(dir, "p1", "BIGGEST", 5000, 1);
    session(dir, "p2", "MIDDLE", 2000, 1);
    const limitGB = 4000 / 1024 ** 3;

    expect(await dataSize(dir)).toBeGreaterThan(7000);
    const first = await sizeWarning({ data: dir, warnAtGB: limitGB, now: NOW });
    expect(first).toContain("BIGGEST");
    expect(first).toContain("MIDDLE");
    expect(first).toContain("dovet sessions delete --older-than");
    expect(first).toContain("dovet gc");
    expect(first?.indexOf("BIGGEST")).toBeLessThan(first?.indexOf("MIDDLE") ?? 0);

    expect(await sizeWarning({ data: dir, warnAtGB: limitGB, now: NOW + 3_600_000 })).toBeUndefined();
    expect(await sizeWarning({ data: dir, warnAtGB: limitGB, now: NOW + DAY })).toContain("BIGGEST");
  });

  // spec: AC-LOG-14
  test("says nothing under the limit and does not use the day's one warning", async () => {
    const dir = await data();
    session(dir, "p1", "S", 100, 1);
    expect(await sizeWarning({ data: dir, warnAtGB: 10, now: NOW })).toBeUndefined();
    expect(existsSync(join(dir, "size-warning.json"))).toBe(false);
  });

  test("a missing data directory is empty", async () => {
    const dir = await data();
    expect(await dataSize(join(dir, "nope"))).toBe(0);
    expect(await listStored(join(dir, "nope"), NOW)).toEqual([]);
  });
});

describe("stored sessions", () => {
  test("lists every project's sessions with their disk use, offload and sidecar included", async () => {
    const dir = await data();
    session(dir, "p1", "A", 100, 3);
    session(dir, "p2", "B", 300, 1);
    const stored = await listStored(dir, NOW);
    expect(stored.map((s) => [s.project, s.id, s.bytes, s.active])).toEqual([
      ["p1", "A", 100 + 2 + 10, false],
      ["p2", "B", 300 + 2 + 10, false],
    ]);
  });

  test("delete <id> removes the log, sidecar and offload directory", async () => {
    const dir = await data();
    session(dir, "p1", "A", 100, 3);
    session(dir, "p1", "B", 100, 3);
    const result = await deleteStored(dir, NOW, { ids: ["A"] });
    expect(result.deleted.map((s) => s.id)).toEqual(["A"]);
    expect((await listStored(dir, NOW)).map((s) => s.id)).toEqual(["B"]);
    expect(existsSync(join(dir, "projects", "p1", "sessions", "A"))).toBe(false);
  });

  test("--older-than and --larger-than pick by age and by size, and an unknown id is reported", async () => {
    const dir = await data();
    session(dir, "p1", "OLD", 10, 40);
    session(dir, "p1", "NEW", 10, 5);
    session(dir, "p1", "BIG", 5000, 1);
    expect((await deleteStored(dir, NOW, { olderThanDays: 30 })).deleted.map((s) => s.id)).toEqual(["OLD"]);
    expect((await deleteStored(dir, NOW, { largerThanBytes: 1000 })).deleted.map((s) => s.id)).toEqual(["BIG"]);
    expect((await deleteStored(dir, NOW, { ids: ["NEW", "GHOST"] })).missing).toEqual(["GHOST"]);
  });

  test("a session with a fresh lock is never deleted", async () => {
    const dir = await data();
    session(dir, "p1", "LIVE", 5000, 90, true);
    const result = await deleteStored(dir, NOW, { olderThanDays: 1 });
    expect(result.deleted).toEqual([]);
    expect(result.skippedActive.map((s) => s.id)).toEqual(["LIVE"]);
    expect(existsSync(join(dir, "projects", "p1", "sessions", "LIVE.jsonl"))).toBe(true);
  });

  test("an id cannot reach outside the sessions folder", async () => {
    const dir = await data();
    session(dir, "p1", "A", 10, 1);
    writeFileSync(join(dir, "keep.txt"), "k");
    const result = await deleteStored(dir, NOW, { ids: ["../../../keep.txt", "A/../../A"] });
    expect(result.deleted).toEqual([]);
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  });

  test("parses sizes with units and refuses anything else", () => {
    expect(parseSize("500")).toBe(500);
    expect(parseSize("1KB")).toBe(1024);
    expect(parseSize("2mb")).toBe(2 * 1024 ** 2);
    expect(parseSize("1.5GB")).toBe(1.5 * 1024 ** 3);
    for (const bad of ["", "-1MB", "MB", "1TBX", "NaN", "1e3"]) expect(parseSize(bad)).toBeUndefined();
  });
});
