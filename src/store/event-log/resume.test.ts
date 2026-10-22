import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fakeClock, sequentialIds, type TempProject, tempProject } from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import type { EventType } from "../../schema/index.ts";
import { openSession, type SessionLocation, sessionPaths } from "./index.ts";
import {
  forkSession,
  isHistoryRelated,
  normalizeForRepair,
  type RepairOp,
  repairEpochEvent,
  resumeSession,
  validateTranscriptItems,
} from "./resume.ts";

const OS: Os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
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

async function writer(loc: SessionLocation, seed = "1") {
  const r = await openSession({
    ...loc,
    clock: fakeClock(Date.UTC(2026, 9, 13)),
    ids: sequentialIds(seed),
    pid: 4242,
    host: "test-host",
    secrets: [],
    flushMs: 60_000,
  });
  if (r.mode !== "write") throw new Error(`expected a writer, got read-only: ${r.reason}`);
  return r.writer;
}

async function appendRepairs(loc: SessionLocation, repairs: RepairOp[], seed: string): Promise<void> {
  if (repairs.length === 0) return;
  const w = await writer(loc, seed);
  for (const r of repairs) w.append({ type: r.type as EventType, epoch: r.epoch, turn: r.turn, data: r.data });
  await w.close();
}

function pairingOk(calls: string[], results: string[]): boolean {
  return calls.length === results.length && calls.every((c, i) => c === results[i]);
}

// spec: AC-LOG-11
test("SIGKILL during a Bash call repairs to an interrupted result and a crashed turn", async () => {
  const loc = await location();
  const w = await writer(loc);
  w.append({ type: "session.start", epoch: 0, turn: null, data: { mode: "default" } });
  w.append({
    type: "epoch.start",
    epoch: 0,
    turn: null,
    data: {
      epoch: 0,
      reason: "session-start",
      provider: "nvidia",
      model: "m",
      systemText: "sys",
      toolsJson: "[]",
      thinking: { mode: "off" },
      promptVersion: "a".repeat(64),
    },
  });
  w.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "run it" } });
  w.append({ type: "tool.call", epoch: 0, turn: 1, data: { callId: "c1", name: "Bash", raw: {}, input: {} } });
  w.append({ type: "permission.request", epoch: 0, turn: 1, data: { requestId: "q1", callId: "c1", kind: "tool" } });
  await w.close();

  const resumed = await resumeSession(loc);
  expect(resumed.readOnly).toBeUndefined();
  const kinds = resumed.repairs.map((r) => [
    r.type,
    (r.data as { callId?: string }).callId ?? (r.data as { turn?: number }).turn,
  ]);
  expect(kinds).toContainEqual(["permission.decision", undefined]);
  expect(kinds).toContainEqual(["tool.result", "c1"]);
  const result = resumed.repairs.find((r) => r.type === "tool.result");
  expect(result?.data).toMatchObject({
    callId: "c1",
    status: "interrupted",
    output:
      "Not run or not finished: Dovet exited before this tool completed. Check the current state before retrying.",
  });
  const decision = resumed.repairs.find((r) => r.type === "permission.decision");
  expect(decision?.data).toMatchObject({ requestId: "q1", decision: "no", source: "interrupted" });
  expect(resumed.repairs.at(-2)?.data).toMatchObject({ reason: "crashed" });

  await appendRepairs(loc, resumed.repairs, "2");
  const { readSession } = await import("./index.ts");
  const read = await readSession(loc);
  expect(read.readOnly).toBeUndefined();
  const calls = read.events.filter((e) => e.type === "tool.call").map((e) => (e.data as { callId: string }).callId);
  const results = read.events.filter((e) => e.type === "tool.result").map((e) => (e.data as { callId: string }).callId);
  expect(pairingOk(calls, results)).toBe(true);
  expect(read.events.at(-2)?.type).toBe("turn.end");
  validateTranscriptItems(
    read.events.flatMap((e) => {
      if (e.type === "user.message") {
        return [{ kind: "user", parts: [{ kind: "text", text: (e.data as { text: string }).text }] }];
      }
      return [];
    }),
  );
});

// spec: AC-LOG-01
test("SIGKILL mid-stream loses at most the in-flight response and stays resumable", async () => {
  const loc = await location();
  const w = await writer(loc);
  w.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "hi" } });
  w.append({
    type: "model.request",
    epoch: 0,
    turn: 1,
    data: { provider: "nvidia", model: "m", params: { maxTokens: 1 }, messageCount: 1, bodySha256: "a".repeat(64) },
  });
  await w.close();

  const resumed = await resumeSession(loc);
  expect(resumed.readOnly).toBeUndefined();
  expect(resumed.repairs.filter((r) => r.type === "tool.result")).toHaveLength(0);
  expect(resumed.repairs.at(-2)?.type).toBe("turn.end");
  await appendRepairs(loc, resumed.repairs, "2");
  const { readSession } = await import("./index.ts");
  expect((await readSession(loc)).readOnly).toBeUndefined();
});

// spec: AC-LOG-01
test("a writer-repaired torn line resumes cleanly with a warning, like the reader", async () => {
  const loc = await location();
  const first = await writer(loc);
  first.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "one" } });
  first.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
  await first.close();
  const { log } = sessionPaths(loc);
  await writeFile(log, `${await readFile(log, "utf8")}{"v":1,"id":"01J`);
  const second = await writer(loc, "2");
  second.append({ type: "user.message", epoch: 0, turn: 2, data: { text: "two" } });
  await second.close();

  const resumed = await resumeSession(loc);
  expect(resumed.readOnly).toBeUndefined();
  expect(resumed.warnings).toEqual([expect.stringContaining("ignored an incomplete line")]);
  expect(resumed.state.turn).toBe(1);
});

// spec: AC-LOG-01
test.each([
  ["ASCII", Buffer.from('{"v":1,"id":"01J'), false],
  [
    "a cut multi-byte character",
    Buffer.concat([Buffer.from('{"v":1,"text":"'), Buffer.from("😀").subarray(0, 3)]),
    false,
  ],
  ["after an epoch start", Buffer.from('{"v":1,"id":"01J'), true],
])(
  "resuming a torn log (%s), then writing, never glues the new event onto the half line",
  async (_name, tail, epoch) => {
    const loc = await location();
    const first = await writer(loc);
    if (epoch) {
      first.append({
        type: "epoch.start",
        epoch: 0,
        turn: null,
        data: {
          epoch: 0,
          reason: "session-start",
          provider: "nvidia",
          model: "m",
          systemText: "sys",
          toolsJson: "[]",
          thinking: { mode: "off" },
          promptVersion: "b".repeat(64),
        },
      });
    }
    first.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "one" } });
    first.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
    await first.close();
    const { log } = sessionPaths(loc);
    await writeFile(log, Buffer.concat([await readFile(log), tail]));
    expect((await resumeSession(loc)).warnings).toEqual([expect.stringContaining("incomplete last line")]);

    const second = await writer(loc, "2");
    second.append({ type: "user.message", epoch: 0, turn: 2, data: { text: "two" } });
    await second.close();

    const { readSession } = await import("./index.ts");
    const read = await readSession(loc);
    expect(read.readOnly).toBeUndefined();
    const types = ["user.message", "turn.end", "session.resume", "user.message"];
    expect(read.events.map((e) => e.type)).toEqual(epoch ? ["epoch.start", ...types] : types);
    const resumed = await resumeSession(loc);
    expect(resumed.readOnly).toBeUndefined();
    expect(resumed.warnings).toEqual([expect.stringContaining("ignored an incomplete line")]);
  },
);

// spec: AC-LOG-15
test("a parallel batch keeps finished results, interrupts the rest, restores mode/cost/tools", async () => {
  const loc = await location();
  const toolsJson = JSON.stringify([{ name: "Bash" }, { name: "Read" }]);
  const w = await writer(loc);
  w.append({ type: "session.start", epoch: 0, turn: null, data: { mode: "plan" } });
  w.append({
    type: "epoch.start",
    epoch: 0,
    turn: null,
    data: {
      epoch: 0,
      reason: "session-start",
      provider: "nvidia",
      model: "m",
      systemText: "sys",
      toolsJson,
      thinking: { mode: "off" },
      promptVersion: "b".repeat(64),
    },
  });
  w.append({ type: "user.message", epoch: 0, turn: 3, data: { text: "go" } });
  for (const id of ["r1", "r2", "r3", "b1"]) {
    w.append({
      type: "tool.call",
      epoch: 0,
      turn: 3,
      data: { callId: id, name: id === "b1" ? "Bash" : "Read", raw: {}, input: {} },
    });
  }
  w.append({ type: "tool.result", epoch: 0, turn: 3, data: { callId: "r1", status: "ok", output: "one" } });
  w.append({ type: "tool.result", epoch: 0, turn: 3, data: { callId: "r2", status: "ok", output: "two" } });
  w.append({ type: "receipt", epoch: 0, turn: 2, data: { turn: 2, cost: { sessionUsd: 1.25 } } });
  await w.close();

  const resumed = await resumeSession(loc);
  expect(resumed.readOnly).toBeUndefined();
  expect(resumed.state.mode).toBe("plan");
  expect(resumed.state.costUsd).toBe(1.25);
  // A resume under narrower current settings still replays the stored bytes: the state carries the
  // epoch's stored definitions, and the adapter renders requests from them (byte-identical replay is
  // proven request-by-request in the transcript replay test).
  const narrower = JSON.stringify([{ name: "Read" }]);
  expect(narrower).not.toBe(toolsJson);
  expect(resumed.state.toolsJson).toBe(toolsJson);
  expect(JSON.parse(resumed.state.toolsJson)).toEqual(JSON.parse(toolsJson));
  const interrupted = resumed.repairs.filter((r) => r.type === "tool.result");
  expect(interrupted.map((r) => (r.data as { callId: string }).callId).sort()).toEqual(["b1", "r3"]);
  for (const r of interrupted) {
    expect(r.data).toMatchObject({
      status: "interrupted",
      output:
        "Not run or not finished: Dovet exited before this tool completed. Check the current state before retrying.",
    });
  }

  await appendRepairs(loc, resumed.repairs, "9");
  const { readSession } = await import("./index.ts");
  const read = await readSession(loc);
  const outs = new Map(
    read.events.filter((e) => e.type === "tool.result").map((e) => [(e.data as { callId: string }).callId, e.data]),
  );
  expect((outs.get("r1") as { output: string }).output).toBe("one");
  expect((outs.get("r2") as { output: string }).output).toBe("two");
  expect(read.events.filter((e) => e.type === "turn.end" && e.turn === 3)).toHaveLength(1);
});

// spec: AC-LOG-12
describe("history rejection and the repair epoch", () => {
  test("only a non-retryable history invalid_request counts as history-related", () => {
    expect(
      isHistoryRelated({ kind: "invalid_request", retryable: false, message: "history is invalid: empty text block" }),
    ).toBe(true);
    expect(
      isHistoryRelated({ kind: "invalid_request", retryable: false, message: "tool_result without tool_use" }),
    ).toBe(true);
    expect(isHistoryRelated({ kind: "invalid_request", retryable: false, message: "schema too complex" })).toBe(false);
    expect(isHistoryRelated({ kind: "server", retryable: true, message: "history broke" })).toBe(false);
  });

  test("repair normalization drops reasoning and empty text, and drops unpaired tool calls when paired set is given", () => {
    const stored = {
      provider: "nvidia",
      protocol: "openai-chat" as const,
      package: "p",
      packageVersion: "v",
      modelId: "m",
      parts: [
        { kind: "reasoning" as const, summary: "hmm", replay: undefined },
        { kind: "text" as const, text: "  \n " },
        { kind: "text" as const, text: "keep" },
        { kind: "tool_call" as const, id: "c1", name: "read", inputJson: "{}" },
        { kind: "tool_call" as const, id: "c2", name: "write", inputJson: "{}" },
      ],
      usage: {},
      finishReason: "stop",
    };
    expect(normalizeForRepair(stored, new Set(["c1"]))?.parts).toEqual([
      { kind: "text", text: "keep" },
      { kind: "tool_call", id: "c1", name: "read", inputJson: "{}" },
    ]);
    expect(normalizeForRepair({ ...stored, parts: stored.parts.slice(0, 2) })).toBeNull();
  });

  test("the repair epoch appends without rewriting earlier lines", async () => {
    const loc = await location();
    const w = await writer(loc);
    w.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "hi" } });
    await w.close();
    const { log } = sessionPaths(loc);
    const before = await readFile(log, "utf8");
    const resumed = await resumeSession(loc);
    const w2 = await writer(loc, "2");
    const ev = repairEpochEvent(resumed.state);
    expect(ev.epoch).toBe(resumed.state.epoch + 1);
    expect((ev.data as { reason: string }).reason).toBe("repair");
    w2.append({ type: "epoch.start", epoch: ev.epoch, turn: null, data: ev.data });
    await w2.close();
    const after = await readFile(log, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain('"repair"');
  });

  test("the transcript validator rejects content Dovet must never send", () => {
    expect(() => validateTranscriptItems([{ kind: "user", parts: [{ kind: "text", text: "   " }] }])).toThrow(
      "whitespace-only",
    );
    expect(() =>
      validateTranscriptItems([{ kind: "assistant", stored: { parts: [{ kind: "reasoning", summary: "x" }] } }]),
    ).toThrow("only reasoning");
    expect(() => validateTranscriptItems([{ kind: "user", parts: [{ kind: "padding" }] }])).toThrow("padding block");
    expect(() =>
      validateTranscriptItems([
        {
          kind: "user",
          parts: [
            {
              kind: "tool_result",
              content: [{ kind: "object", text: "invalid" }],
            },
          ],
        },
      ]),
    ).toThrow("non-text tool output");
  });

  test("a sidecar with a mismatched epochEventId falls back to full scanning", async () => {
    const loc = await location();
    const w = await writer(loc);
    w.append({
      type: "epoch.start",
      epoch: 0,
      turn: null,
      data: {
        epoch: 0,
        reason: "session-start",
        provider: "p",
        model: "m",
        systemText: "s",
        toolsJson: "[]",
        thinking: { mode: "off" },
        promptVersion: "a".repeat(64),
      },
    });
    w.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "hello" } });
    w.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
    await w.close();
    const first = await resumeSession(loc);
    expect(first.fastPath).toBe(false);
    const { meta } = sessionPaths(loc);
    const sidecar = JSON.parse(await readFile(meta, "utf8")) as Record<string, unknown>;
    sidecar.epochEventId = "01CORRUPTEDEVENTID00000000";
    await writeFile(meta, `${JSON.stringify(sidecar)}\n`);
    const second = await resumeSession(loc);
    expect(second.fastPath).toBe(false);
    expect(second.state).toEqual(first.state);
  });
});

// spec: AC-LOG-13
test("a 500 MB synthetic log resumes with the sidecar in under 2 s and scans fully in under 30 s", async () => {
  const loc = await location();
  const { log, meta } = sessionPaths(loc);
  await mkdir(sessionPaths(loc).dir, { recursive: true });
  const pad = "x".repeat(60 * 1024);
  const line = (n: number, epoch = 0, turn = 1): string =>
    `${JSON.stringify({ v: 1, id: `01H${String(n).padStart(23, "0")}`, ts: "2026-10-13T00:00:00.000Z", session: SESSION, epoch, turn, type: "tool.result", core: true, data: { callId: `c${n}`, status: "ok", output: pad } })}\n`;
  const head = `${JSON.stringify({ v: 1, id: `01H${"0".repeat(23)}`, ts: "2026-10-13T00:00:00.000Z", session: SESSION, epoch: 0, turn: null, type: "epoch.start", core: true, data: { epoch: 0, reason: "session-start", provider: "nvidia", model: "m", systemText: "s", toolsJson: "[]", thinking: { mode: "off" }, promptVersion: "c".repeat(64) } })}\n`;
  const N = 8500;
  const TAIL = 100;
  await writeFile(log, head);
  for (let i = 0; i < N; i += 100) {
    let chunk = "";
    for (let j = i; j < Math.min(i + 100, N); j++) chunk += line(j + 1, 0, 4);
    await appendFile(log, chunk);
  }
  await appendFile(
    log,
    `${JSON.stringify({ v: 1, id: `01H${"1".repeat(23)}`, ts: "2026-10-13T00:00:00.000Z", session: SESSION, epoch: 1, turn: null, type: "epoch.start", core: true, data: { epoch: 1, reason: "compaction", provider: "nvidia", model: "m", systemText: "s", toolsJson: "[]", thinking: { mode: "off" }, promptVersion: "c".repeat(64) } })}\n`,
  );
  for (let j = 0; j < TAIL; j++) await appendFile(log, line(N + 1 + j, 1, 5));
  expect((await stat(log)).size).toBeGreaterThan(500 * 1024 * 1024);
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../../test/fixtures/resume/scan-child.ts"),
      loc.data,
      loc.projectRoot,
      SESSION,
      OS,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 100_000 },
  );
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, err).toBe(0);
  // A fresh process measures the scan itself: the writes above leave garbage and cached pages that moved the
  // old in-process RSS number by more than the runner's noise. Best of three keeps one slow disk read out of it.
  const r = z
    .object({
      fullMs: z.number(),
      fastMs: z.array(z.number()).length(3),
      rssGrowth: z.number(),
      full: z.object({ readOnly: z.string().optional(), fastPath: z.boolean(), lines: z.number(), epoch: z.number() }),
      fast: z.object({ readOnly: z.string().optional(), fastPath: z.boolean(), lines: z.number(), epoch: z.number() }),
      sameState: z.boolean(),
    })
    .parse(JSON.parse(out));
  expect(r.full.readOnly).toBeUndefined();
  expect(r.full.fastPath).toBe(false);
  expect(r.fullMs).toBeLessThan(30_000);
  expect(r.fast.readOnly).toBeUndefined();
  expect(r.fast.fastPath).toBe(true);
  expect(Math.min(...r.fastMs)).toBeLessThan(2000);
  expect(r.fast.epoch).toBe(r.full.epoch);
  expect(r.sameState).toBe(true);
  expect(r.fast.lines).toBeLessThan(r.full.lines);
  // The scan streams line by line and folds state instead of materializing the file: peak growth stays far
  // under the 300 MB budget (a whole-file read would exceed it several times over).
  expect(r.rssGrowth).toBeLessThan(300 * 1024 * 1024);
  expect(await readFile(meta, "utf8")).toContain("epochEventId");
}, 120_000);

// spec: AC-LOG-16
test("a fork copies through an older writer-repaired torn line", async () => {
  const loc = await location();
  const first = await writer(loc);
  first.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "one" } });
  first.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
  await first.close();
  const { log } = sessionPaths(loc);
  await writeFile(log, `${await readFile(log, "utf8")}{"v":1,"id":"01J`);
  const second = await writer(loc, "2");
  second.append({ type: "user.message", epoch: 0, turn: 2, data: { text: "two" } });
  second.append({ type: "turn.end", epoch: 0, turn: 2, data: { reason: "end_turn" } });
  await second.close();
  const lines = (await readFile(log, "utf8")).split("\n");
  const turn2 = lines.findIndex((l) => l.includes('"two"'));
  lines[turn2] = "not json";
  await writeFile(log, lines.join("\n"));

  const resumed = await resumeSession(loc);
  expect(resumed.readOnly).toMatch(/line \d+/);
  expect(resumed.forkTurn).toBe(1);
  const forked = await forkSession(loc, "01J0000000000000000000000E", 1, {
    ids: sequentialIds("E"),
    clock: fakeClock(Date.UTC(2026, 9, 14)),
  });
  expect(forked.copied).toBe(2);
  const { readSession } = await import("./index.ts");
  const read = await readSession({ ...loc, session: "01J0000000000000000000000E" });
  expect(read.readOnly).toBeUndefined();
  expect(read.events.filter((e) => e.type === "turn.end")).toHaveLength(1);
  expect(read.events.at(-1)?.type).toBe("session.fork");
});

// spec: AC-LOG-16
test("a corrupted line opens read-only and forks from the last complete turn", async () => {
  const loc = await location();
  const w = await writer(loc);
  for (let turn = 1; turn <= 10; turn++) {
    w.append({ type: "user.message", epoch: 0, turn, data: { text: `task ${turn}` } });
    w.append({ type: "turn.end", epoch: 0, turn, data: { reason: "end_turn" } });
  }
  await w.close();
  const { log } = sessionPaths(loc);
  const before = await readFile(log, "utf8");
  const lines = before.split("\n");
  const idx = lines.findIndex((l) => l.includes("task 7"));
  lines[idx] = "not json";
  await writeFile(log, lines.join("\n"));

  const resumed = await resumeSession(loc);
  expect(resumed.readOnly).toMatch(/line \d+/);
  expect(resumed.forkTurn).toBe(6);

  const forked = await forkSession(loc, "01J0000000000000000000000F", 6, {
    ids: sequentialIds("F"),
    clock: fakeClock(Date.UTC(2026, 9, 14)),
  });
  expect((await readFile(log, "utf8")).length).toBe(lines.join("\n").length);
  const { readSession } = await import("./index.ts");
  const read = await readSession({ ...loc, session: "01J0000000000000000000000F" });
  expect(read.readOnly).toBeUndefined();
  expect(read.events.filter((e) => e.type === "turn.end")).toHaveLength(6);
  expect(forked.copied).toBeGreaterThan(0);
  const w2 = await writer({ ...loc, session: "01J0000000000000000000000F" }, "G");
  w2.append({ type: "user.message", epoch: 0, turn: 7, data: { text: "continued" } });
  await w2.close();
  expect((await readSession({ ...loc, session: "01J0000000000000000000000F" })).events.at(-1)?.type).toBe(
    "user.message",
  );
});
