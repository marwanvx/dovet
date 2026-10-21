// `dovet gc`, `dovet sessions …` and the startup housekeeping (cli-config "Commands", event-log "Disk use").
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMaintenance, runStorageCommand, type StorageInput, storageSettings } from "./storage-command.ts";

const DAY = 86_400_000;
const NOW = Date.now();
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function data(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dovet-tool-cmd-")));
  roots.push(dir);
  return dir;
}

function session(dir: string, id: string, bytes: number, days: number): string {
  const sessions = join(dir, "projects", "p1", "sessions");
  mkdirSync(sessions, { recursive: true });
  const log = join(sessions, `${id}.jsonl`);
  writeFileSync(log, "x".repeat(bytes));
  utimesSync(log, new Date(NOW - days * DAY), new Date(NOW - days * DAY));
  return log;
}

const input = (dir: string, over: Partial<StorageInput["settings"]> = {}): StorageInput => ({
  data: dir,
  now: NOW,
  settings: { ...storageSettings(undefined), ...over },
  env: {},
});

describe("dovet sessions", () => {
  test("list shows each session with its date and size, and --size puts the largest first", async () => {
    const dir = await data();
    session(dir, "AAA", 100, 5);
    session(dir, "BBB", 5000, 1);
    const plain = await runStorageCommand(["sessions", "list"], input(dir));
    const bySize = await runStorageCommand(["sessions", "list", "--size"], input(dir));
    expect(plain.exitCode).toBe(0);
    expect(plain.output.indexOf("AAA")).toBeLessThan(plain.output.indexOf("BBB"));
    expect(bySize.output.indexOf("BBB")).toBeLessThan(bySize.output.indexOf("AAA"));
    expect(plain.output).toContain("4.9 KB");
    expect(plain.output).toContain("2 sessions");
  });

  test("delete removes what was asked for and says what was freed; unknown ids are an error", async () => {
    const dir = await data();
    const old = session(dir, "OLD", 100, 40);
    const fresh = session(dir, "NEW", 100, 1);
    const byAge = await runStorageCommand(["sessions", "delete", "--older-than", "30"], input(dir));
    expect(byAge.output).toContain("Deleted OLD");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    const ghost = await runStorageCommand(["sessions", "delete", "GHOST"], input(dir));
    expect(ghost.exitCode).toBe(1);
    expect(ghost.output).toContain("No stored session GHOST");
    const bySize = await runStorageCommand(["sessions", "delete", "--larger-than", "10"], input(dir));
    expect(bySize.output).toContain("Deleted NEW");
  });

  test("delete reclaims the blobs only the deleted session used", async () => {
    const dir = await data();
    session(dir, "OLD", 10, 3);
    const blob = join(dir, "blobs", "ab", "ab".repeat(32));
    mkdirSync(join(dir, "blobs", "ab"), { recursive: true });
    writeFileSync(blob, "orphan");
    utimesSync(blob, new Date(0), new Date(0));
    const out = await runStorageCommand(["sessions", "delete", "OLD"], input(dir));
    expect(existsSync(blob)).toBe(false);
    expect(out.output).toContain("Removed 1 unreferenced blobs");
  });

  test.each([
    [["sessions"]],
    [["sessions", "delete"]],
    [["sessions", "delete", "--older-than"]],
    [["sessions", "delete", "--older-than", "soon"]],
    [["sessions", "delete", "--larger-than", "big"]],
    [["sessions", "delete", "A", "B"]],
    [["sessions", "list", "--bogus"]],
    [["gc", "now"]],
  ])("%j is a usage error and changes nothing", async (argv) => {
    const dir = await data();
    const log = session(dir, "KEEP", 10, 400);
    const out = await runStorageCommand(argv, input(dir));
    expect(out.exitCode).toBe(2);
    expect(existsSync(log)).toBe(true);
  });
});

describe("dovet gc", () => {
  test("reports what it removed, and a second run finds nothing", async () => {
    const dir = await data();
    session(dir, "A", 10, 1);
    const blob = join(dir, "blobs", "cd", "cd".repeat(32));
    mkdirSync(join(dir, "blobs", "cd"), { recursive: true });
    writeFileSync(blob, "orphan");
    utimesSync(blob, new Date(0), new Date(0));
    const first = await runStorageCommand(["gc"], input(dir));
    expect(first.output).toContain("Removed 1 unreferenced blobs");
    const second = await runStorageCommand(["gc"], input(dir));
    expect(second.output).toContain("Removed 0 unreferenced blobs");
  });
});

describe("startup housekeeping", () => {
  // spec: AC-LOG-14
  test("warns once about the data size and collects in the background; a failure is a line, not a crash", async () => {
    const dir = await data();
    session(dir, "BIG", 5000, 1);
    const old = join(dir, "projects", "p1", "sessions", "BIG", "outputs");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "c1.txt"), "out");
    utimesSync(join(old, "c1.txt"), new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));

    const first = await runMaintenance(input(dir, { warnAtGB: 1000 / 1024 ** 3 }));
    expect(first.join("\n")).toContain("BIG");
    expect(existsSync(join(old, "c1.txt"))).toBe(false);
    expect(await runMaintenance(input(dir, { warnAtGB: 1000 / 1024 ** 3 }))).toEqual([]);

    const broken = await runMaintenance({ ...input(dir), data: join(dir, "projects", "p1", "sessions", "BIG.jsonl") });
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatch(/GC could not run/);
  });
});
