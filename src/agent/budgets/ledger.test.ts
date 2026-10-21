import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyLedger, dayKey } from "./ledger.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const fresh = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "dovet-ledger-"));
  dirs.push(d);
  return d;
};
const NOW = new Date(2026, 9, 22, 14, 30).getTime();
const ledger = (dir: string, session: string, now = NOW): DailyLedger =>
  new DailyLedger({ dir, session, now: () => now });

describe("daily ledger", () => {
  test("names the file after the local date", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 0, 6, 0, 0).getTime())).toBe("2026-01-06");
  });

  test("appends reserve, commit and release lines", async () => {
    const dir = await fresh();
    const l = ledger(dir, "S1");
    expect((await l.reserve("r1", 0.4, null)).ok).toBe(true);
    expect(await l.commit("r1", 0.35)).toBeCloseTo(0.35, 10);
    await l.reserve("r2", 0.1, null);
    await l.release("r2");
    const text = await readFile(join(dir, "2026-10-22.ledger"), "utf8");
    expect(text.split("\n").filter(Boolean)).toEqual([
      `reserve S1 r1 0.400000 ${NOW}`,
      "commit r1 0.350000",
      `reserve S1 r2 0.100000 ${NOW}`,
      "release r2",
    ]);
  });

  // spec: AC-RCPT-04
  test("two sessions racing at 95% of the daily budget: at most one request is dispatched", async () => {
    const dir = await fresh();
    const seed = ledger(dir, "S0");
    await seed.reserve("seed", 9.5, 10);
    await seed.commit("seed", 9.5);
    for (let round = 0; round < 25; round++) {
      const a = ledger(dir, "SA");
      const b = ledger(dir, "SB");
      const [ra, rb] = await Promise.all([a.reserve(`a${round}`, 0.3, 10), b.reserve(`b${round}`, 0.3, 10)]);
      expect([ra.ok, rb.ok].filter(Boolean).length).toBe(1);
      await a.release(`a${round}`);
      await b.release(`b${round}`);
    }
  });

  // spec: AC-RCPT-04
  test("many sessions racing for the last dollar dispatch exactly as many requests as fit", async () => {
    const dir = await fresh();
    const sessions = Array.from({ length: 8 }, (_, i) => ledger(dir, `S${i}`));
    const results = await Promise.all(sessions.map((l, i) => l.reserve(`q${i}`, 0.3, 1)));
    expect(results.filter((r) => r.ok).length).toBe(3);
  });

  // spec: AC-RCPT-05
  test("a crashed session's outstanding reservation is counted until it is reconciled", async () => {
    const dir = await fresh();
    const crashed = ledger(dir, "DEAD");
    await crashed.reserve("lost", 4, 10);
    const later = ledger(dir, "LIVE", NOW + 31 * 60_000);
    const blocked = await later.reserve("r1", 6.5, 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.daySpent).toBeCloseTo(4, 10);
    expect((await later.reserve("r1", 5.9, 10)).ok).toBe(true);
    await later.release("r1");
    await crashed.release("lost");
    expect((await later.reserve("r2", 9.9, 10)).ok).toBe(true);
  });

  test("a commit replaces the estimate and a release removes it", async () => {
    const dir = await fresh();
    const l = ledger(dir, "S1");
    await l.reserve("a", 2, 10);
    await l.commit("a", 3);
    await l.reserve("b", 2, 10);
    await l.release("b");
    const r = await l.reserve("c", 0, 10);
    expect(r.daySpent).toBeCloseTo(3, 10);
  });

  test("a stale lock file (older than 2 s) is taken over; a fresh one is waited for", async () => {
    const dir = await fresh();
    const lock = join(dir, "2026-10-22.ledger.lock");
    await writeFile(lock, "999");
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);
    expect((await ledger(dir, "S1").reserve("r1", 1, null)).ok).toBe(true);
    await expect(stat(lock)).rejects.toThrow();
  });

  test("releaseOutstanding releases every reservation this session still holds", async () => {
    const dir = await fresh();
    const l = ledger(dir, "S1");
    await l.reserve("a", 1, null);
    await l.reserve("b", 1, null);
    await l.commit("a", 0.5);
    await l.releaseOutstanding();
    const r = await ledger(dir, "S2").reserve("c", 0, null);
    expect(r.daySpent).toBeCloseTo(0.5, 10);
  });

  test("a torn last line and unknown lines are skipped; the ledger is created with owner-only modes", async () => {
    const dir = await fresh();
    await ledger(dir, "S0").reserve("first", 0, null);
    await appendFile(join(dir, "2026-10-22.ledger"), `commit x 1.000000\nbogus line\nreserve S9 y 2.0000`);
    const r = await ledger(dir, "S1").reserve("r1", 0, null);
    expect(r.daySpent).toBeCloseTo(1, 10);
    if (process.platform !== "win32") expect((await stat(join(dir, "2026-10-22.ledger"))).mode & 0o077).toBe(0);
  });

  test("a lock that is never released fails the request instead of waiting forever", async () => {
    const dir = await fresh();
    await writeFile(join(dir, "2026-10-22.ledger.lock"), "1");
    const l = new DailyLedger({ dir, session: "S1", now: () => NOW, staleMs: 60_000, waitMs: 80 });
    await expect(l.reserve("r1", 1, 10)).rejects.toThrow("ledger is locked");
  });
});
