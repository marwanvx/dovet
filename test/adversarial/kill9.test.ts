// M2 exit evidence: a session killed with SIGKILL at a random moment is never corrupted (roadmap M2 exit evidence;
// event-log "Writer rules"). The child writes files through the real headless run (checkpoints, blobs, budget ledger,
// event log); the parent checks every store the run writes, resumes the session and runs it to the end.
import { expect, test } from "bun:test";
import { readdir, readFile, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { DailyLedger } from "../../src/agent/budgets/ledger.ts";
import { ToolResultData } from "../../src/schema/index.ts";
import { readSession } from "../../src/store/index.ts";
import { fileContent, settingsText } from "../fixtures/kill9/content.ts";
import { tempProject } from "../helpers/index.ts";
import { runIn, scripted, testOs } from "./harness.ts";

const CHILD = join(import.meta.dir, "..", "fixtures", "kill9", "child.ts");
const WRITERS = join(import.meta.dir, "..", "fixtures", "kill9", "writers.ts");
const ROUNDS = Number(process.env.DOVET_KILL9_ROUNDS ?? 6);

/** A small seeded generator so a failing round can be replayed. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const seen = await Promise.race([
    reader.read().then((r) => new TextDecoder().decode(r.value)),
    Bun.sleep(60_000).then(() => "timeout"),
  ]);
  reader.releaseLock();
  return seen.trim();
}

// spec: roadmap M2 exit evidence
test(`kill -9 at ${ROUNDS} random points leaves every store readable and the session resumable`, async () => {
  const random = prng(Number(process.env.DOVET_KILL9_SEED ?? 20261022));
  for (let round = 0; round < ROUNDS; round++) {
    const delay = Math.floor(random() * 3200);
    const dir = await tempProject();
    try {
      const child = Bun.spawn([process.execPath, CHILD, dir.root], { stdout: "pipe", stderr: "pipe" });
      expect(await firstLine(child.stdout)).toBe("READY");
      await Bun.sleep(delay);
      child.kill("SIGKILL");
      await child.exited;
      const where = `round ${round}, killed ${delay} ms after the first request`;

      for (let i = 0; i < 5; i++) {
        const text = await readFile(join(dir.root, "out", `f${i}.txt`), "utf8").catch(() => undefined);
        if (text === undefined) continue;
        const written = /^file \d+ round (\d+)\n/.exec(text)?.[1];
        expect(text, `${where}: f${i}.txt is torn`).toBe(fileContent(i, Number(written)));
      }

      const files = await walk(join(dir.root, "data"));
      for (const blob of files.filter((f) => /[\\/]blobs[\\/]/.test(f) && !f.endsWith(".tmp"))) {
        const sha = blob.split(/[\\/]/).at(-1) ?? "";
        const bytes = new Uint8Array(await readFile(blob));
        expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), `${where}: damaged blob ${sha}`).toBe(sha);
      }
      for (const ledger of files.filter((f) => f.endsWith(".ledger"))) {
        const lines = (await readFile(ledger, "utf8")).split("\n");
        const complete = lines.slice(0, -1);
        for (const line of complete) expect(line, `${where}: ${ledger}`).toMatch(/^(reserve|commit|release) /);
      }

      const sessions = files.filter((f) => f.endsWith(".jsonl"));
      expect(sessions.length, where).toBe(1);
      const id =
        (sessions[0] ?? "")
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.jsonl$/, "") ?? "";
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: id };
      const before = await readSession(loc as never);
      expect(before.events.length, where).toBeGreaterThan(0);

      // The dead writer's lock is taken over once its heartbeat is 2 minutes old (event-log "Writer rules" 1).
      const old = new Date(Date.now() - 3 * 60_000);
      for (const lock of files.filter((f) => f.endsWith(".lock") && f.includes("sessions")))
        await utimes(lock, old, old);

      const resumed = await runIn(dir.root, {
        resume: id,
        repair: true,
        adapter: scripted([[]]),
        prompt: "continue",
        pid: process.pid,
        host: hostname(),
        ids: "R",
      });
      expect(resumed.exit, where).toEqual({ kind: "ok" });
      const after = (await readSession(loc as never)).events;
      const calls = after.filter((e) => e.type === "tool.call").map((e) => (e.data as { callId: string }).callId);
      const results = after.filter((e) => e.type === "tool.result").map((e) => ToolResultData.parse(e.data).callId);
      expect(new Set(results), `${where}: every call has a result`).toEqual(new Set(calls));
    } finally {
      await dir.dispose();
    }
  }
}, 240_000);

// spec: roadmap M2 exit evidence
test("kill -9 while the settings, blob and ledger writers loop leaves each file whole or absent, and the ledger usable", async () => {
  const random = prng(Number(process.env.DOVET_KILL9_SEED ?? 20261022) + 1);
  for (let round = 0; round < ROUNDS; round++) {
    const delay = Math.floor(random() * 600);
    const dir = await tempProject();
    try {
      const child = Bun.spawn([process.execPath, WRITERS, dir.root], { stdout: "pipe", stderr: "pipe" });
      expect(await firstLine(child.stdout)).toBe("READY");
      await Bun.sleep(delay);
      child.kill("SIGKILL");
      await child.exited;
      const where = `round ${round}, killed ${delay} ms after the start`;

      const settings = await readFile(join(dir.root, "settings.json"), "utf8").catch(() => undefined);
      if (settings !== undefined)
        expect([settingsText(0), settingsText(1)], `${where}: settings.json is torn`).toContain(settings);

      const files = await walk(join(dir.root, "data"));
      for (const blob of files.filter((f) => /[\\/]blobs[\\/]/.test(f) && !f.endsWith(".tmp"))) {
        const sha = blob.split(/[\\/]/).at(-1) ?? "";
        const bytes = new Uint8Array(await readFile(blob));
        expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), `${where}: damaged blob ${sha}`).toBe(sha);
      }
      for (const file of files.filter((f) => f.endsWith(".ledger"))) {
        const complete = (await readFile(file, "utf8")).split("\n").slice(0, -1);
        for (const line of complete)
          expect(line, `${where}: ${file}`).toMatch(/^(reserve S1 r\d+ 0\.010000 \d+|commit r\d+ 0\.008000)$/);
      }

      // A lock left by the killed writer must not stop the next session's reservation for long (ledger lock, 2 s).
      const next = new DailyLedger({ dir: join(dir.root, "data", "budget"), session: "S2", now: Date.now });
      expect((await next.reserve("after", 0.01, null)).ok, where).toBe(true);
    } finally {
      await dir.dispose();
    }
  }
}, 120_000);
