// Interrupt, queue, harness and signal handling (agent-loop "Interrupts", "Harness messages" and "Process signals and crashes").
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeClock, nvidiaAdapter, SCENARIOS, sequentialIds } from "../../test/helpers/index.ts";
import { createPlatformCore, type Os } from "../platform/index.ts";
import { Settings, type StoredResponse } from "../schema/index.ts";
import { openSession, readSession } from "../store/index.ts";
import {
  createReadState,
  createToolRegistry,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
} from "../tools/index.ts";
import {
  attachQueuedAfterResults,
  buildCrashReport,
  cancelBeforeOutput,
  ctrlEnterOutcome,
  DOUBLE_PRESS_MS,
  EXIT_CRASH,
  EXIT_SIGHUP,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  exitCodeForSignal,
  INTERRUPT_INSTRUCTION,
  InputQueue,
  ignoresRepeatInterrupt,
  mergeToolsInterrupt,
  mustRestoreTerminalFirst,
  PROMPT_INTERRUPTED_REASON,
  queuedAsNextMessage,
  queuedDisposition,
  queuedTextParts,
  SilenceTracker,
  secondPressExits,
  secondSignalExits,
  shouldAppendInterrupted,
  shouldContinueForOpenTasks,
  shutdownPlan,
  sigintOutcome,
  startsNextTurnImmediately,
  streamInterruptResults,
  toolsKeepRunningOnTstp,
} from "./interrupts.ts";
import {
  checkPairing,
  executeTools,
  INTERRUPTED_NOT_RUN,
  INTERRUPTED_TOOL_TEXT,
  interruptResults,
  shutdownResults,
} from "./loop.ts";
import { type BuildEpoch, buildRequest, headerOf } from "./transcript/index.ts";

const found = SCENARIOS.find((s) => s.name === "parallel-tools");
if (found === undefined) throw new Error("parallel-tools scenario is missing");
const scenario = found;

function stored(parts: StoredResponse["parts"]): StoredResponse {
  return {
    provider: "nvidia",
    protocol: "openai-chat",
    package: "@ai-sdk/openai-compatible",
    packageVersion: "x",
    modelId: scenario.model,
    parts,
    usage: {},
    finishReason: "tool_calls",
  };
}

const epoch: BuildEpoch = {
  header: headerOf({
    epoch: 0,
    reason: "session-start",
    provider: "nvidia",
    model: scenario.model,
    systemText: scenario.systemText,
    toolsJson: JSON.stringify(scenario.tools),
    thinking: { mode: "off" },
    promptVersion: "0".repeat(64),
  }),
  params: { maxTokens: 4096 },
  cache: { breakpoints: "auto", ttl: "auto" },
};

function renders(events: Parameters<typeof buildRequest>[0]): void {
  const adapter = nvidiaAdapter("http://unused");
  adapter.render(buildRequest(events, epoch));
}

let counter = 0;
function ev(type: string, data: unknown, turn: number | null = 1): Parameters<typeof buildRequest>[0][number] {
  counter += 1;
  return {
    v: 1,
    id: String(counter).padStart(26, "0"),
    ts: "2026-10-13T00:00:00.000Z",
    session: "00000000000000000000000000",
    epoch: 0,
    turn,
    type: type as "user.message",
    core: true,
    data,
  };
}

function toolDef(name: string, parallelSafe: boolean): ToolDefinition<unknown> {
  return {
    name,
    input: z.strictObject({}).passthrough(),
    descriptionFile: `tools/${name}.md`,
    errorExample: {},
    parallelSafe,
    mutates: parallelSafe ? "none" : "files",
    describeAction: () => ({
      kind: "read",
      paths: [],
      effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
    }),
    run: () => Promise.resolve({ status: "ok", content: [{ kind: "text", text: `${name} ok` }] }),
  };
}

function toolContext(cwd: string): ToolContext {
  const core = createPlatformCore({
    os: "linux",
    arch: "x64",
    execPath: process.execPath,
    env: {},
    projectRoot: cwd as never,
    kill: (pid, signal) => process.kill(pid, signal),
  });
  return {
    session: {
      id: "s",
      cwd: cwd as never,
      workingDirs: [cwd as never],
      mode: "default",
      taint: [],
      interactive: false,
    },
    settings: Settings.parse({}),
    signal: new AbortController().signal,
    readState: createReadState("linux"),
    emit: () => undefined,
    platform: {
      ...core,
      shells: () => ({}),
      clipboard: { readImage: async () => null, writeText: async () => undefined },
    },
    env: {},
    readResults: { lookup: () => undefined },
    contextFreeTokens: 200_000,
    recordWrite: async () => undefined,
  };
}

describe("interrupts per state", () => {
  // spec: AC-LOOP-02
  test("PREPARE/REQUEST before output cancels and restores the prompt", () => {
    const out = cancelBeforeOutput();
    expect(out).toEqual({ endReason: "cancelled", excludeFromTranscript: true, restoreToInputBox: true });
    const kept = [
      ev("user.message", { text: "one" }, 1),
      ev("model.response", stored([{ kind: "text", text: "a" }]), 1),
    ];
    const cancelled = [ev("user.message", { text: "never" }, 2), ev("turn.end", { reason: "cancelled" }, 2)];
    const next = [ev("user.message", { text: "two" }, 3)];
    expect(buildRequest([...kept, ...cancelled, ...next], epoch)).toEqual(buildRequest([...kept, ...next], epoch));
  });

  // spec: AC-LOOP-02
  test("interrupting in every state leaves a renderable transcript", () => {
    expect(INTERRUPT_INSTRUCTION).toBe(
      "The user interrupted your response. Blocks that finished are kept above; the rest was discarded.",
    );
    const completed = stored([
      { kind: "text", text: "working on it" },
      { kind: "tool_call", id: "c1", name: "read", inputJson: "{}" },
    ]);
    expect(shouldAppendInterrupted(completed)).toBe(true);
    const results = streamInterruptResults([{ id: "c1", name: "read", rawJson: "{}" }]);
    const interrupted = results[0]?.output.content[0];
    const interruptedText = interrupted !== undefined && interrupted.kind === "text" ? interrupted.text : "";
    expect(interruptedText).toBe(INTERRUPTED_NOT_RUN);
    const events = [
      ev("user.message", { text: "go" }, 1),
      ev("model.response", completed, 1),
      ev("tool.result", { callId: "c1", status: "interrupted", output: interruptedText }, 1),
      ev("system.injected", { text: INTERRUPT_INSTRUCTION, reason: "interrupt-note", delivery: "reminder-block" }, 1),
    ];
    renders(events);
    const toolsEvents = [
      ev("user.message", { text: "go" }, 1),
      ev(
        "model.response",
        stored([
          { kind: "tool_call", id: "a", name: "read", inputJson: "{}" },
          { kind: "tool_call", id: "b", name: "read", inputJson: "{}" },
        ]),
        1,
      ),
      ev("tool.result", { callId: "a", status: "ok", output: "real" }, 1),
      ev("tool.result", { callId: "b", status: "interrupted", output: INTERRUPTED_TOOL_TEXT }, 1),
    ];
    renders(toolsEvents);
    expect(PROMPT_INTERRUPTED_REASON).toBe("deny (interrupted)");
    expect(ignoresRepeatInterrupt(1000, 1000 + DOUBLE_PRESS_MS - 1)).toBe(true);
    expect(ignoresRepeatInterrupt(1000, 1000 + DOUBLE_PRESS_MS)).toBe(false);
  });

  // spec: AC-LOOP-02
  test("an aborted turn signal interrupts every running call with the spec wording", async () => {
    const registry = createToolRegistry([toolDef("Read", true), toolDef("Bash", false)]);
    const dir = await mkdtemp(join(tmpdir(), "dovet-abort-"));
    try {
      const base = toolContext(dir);
      let runs = 0;
      const { results, stopped } = await executeTools(
        [
          { id: "r1", name: "Read", rawJson: "{}" },
          { id: "b1", name: "Bash", rawJson: "{}" },
        ],
        {
          registry,
          decide: () => ({ behavior: "allow", reason: "test" }),
          prompt: () => Promise.resolve({ allow: true, dontAskAgain: false }),
          run: () => {
            runs += 1;
            return Promise.resolve({ status: "ok", content: [] } satisfies ToolOutput);
          },
          makeContext: () => base,
          offloadDir: join(tmpdir(), "dovet-loop-off"),
          signal: AbortSignal.abort(),
        },
      );
      expect(runs).toBe(0);
      expect(stopped).toBe(false);
      expect(results.map((r) => r.callId)).toEqual(["r1", "b1"]);
      for (const r of results) {
        expect(r.output.status).toBe("interrupted");
        const text = r.output.content[0];
        expect(text !== undefined && text.kind === "text" ? text.text : "").toBe(INTERRUPTED_TOOL_TEXT);
      }
      expect(
        checkPairing(
          ["r1", "b1"],
          results.map((r) => r.callId),
        ),
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // spec: AC-LOOP-02
  test("thinking-only completion appends nothing", () => {
    expect(shouldAppendInterrupted(stored([{ kind: "reasoning", summary: "hmm", replay: undefined as never }]))).toBe(
      false,
    );
    expect(shouldAppendInterrupted(null)).toBe(false);
    expect(shouldAppendInterrupted(stored([{ kind: "text", text: "   \n " }]))).toBe(false);
  });

  // spec: AC-LOOP-02
  test("interrupt and shutdown result helpers use the spec wording", () => {
    const interrupted = interruptResults([{ id: "a", name: "Bash", rawJson: "{}" }]);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.output.status).toBe("interrupted");
    const text = interrupted[0]?.output.content[0];
    expect(text !== undefined && text.kind === "text" ? text.text : "").toBe(INTERRUPTED_TOOL_TEXT);
    expect(shutdownResults()).toEqual([]);
  });

  // spec: AC-LOOP-07
  test("mid-stream text plus tool call are kept with Not-run results", () => {
    const completed = stored([
      { kind: "text", text: "done block" },
      { kind: "tool_call", id: "t1", name: "read", inputJson: '{"path":"a"}' },
    ]);
    expect(shouldAppendInterrupted(completed)).toBe(true);
    const results = streamInterruptResults([{ id: "t1", name: "read", rawJson: '{"path":"a"}' }]);
    expect(results).toHaveLength(1);
    const text = results[0]?.output.content[0];
    expect(text !== undefined && text.kind === "text" ? text.text : "").toBe(INTERRUPTED_NOT_RUN);
    expect(
      checkPairing(
        ["t1"],
        results.map((r) => r.callId),
      ),
    ).toBeNull();
    const events = [
      ev("user.message", { text: "go" }, 1),
      ev("model.response", completed, 1),
      ev("tool.result", { callId: "t1", status: "interrupted", output: INTERRUPTED_NOT_RUN }, 1),
      ev("system.injected", { text: INTERRUPT_INSTRUCTION, reason: "interrupt-note", delivery: "reminder-block" }, 1),
    ];
    renders(events);
    const adapter = nvidiaAdapter("http://unused");
    const call = adapter.render(buildRequest(events, epoch));
    expect((call.messages as unknown[]).length).toBeGreaterThan(2);
  });
});

describe("queued input", () => {
  // spec: AC-LOOP-05
  test("a queued message follows the tool round without breaking pairing", () => {
    const q = new InputQueue();
    q.queue({ text: "and also do x", attachments: [] });
    expect(q.size).toBe(1);
    expect(q.label).toBe("queued (1)");
    const parts = attachQueuedAfterResults(
      [{ kind: "tool_result", callId: "a", isError: false, content: [{ kind: "text", text: "ok" }] }],
      q.takeAll(),
    );
    expect(parts.map((p) => p.kind)).toEqual(["tool_result", "text"]);
    expect(
      checkPairing(
        ["a"],
        parts.flatMap((p) => (p.kind === "tool_result" ? [p.callId] : [])),
      ),
    ).toBeNull();
    expect(q.size).toBe(0);
    const events = [
      ev("user.message", { text: "go" }, 1),
      ev("model.response", stored([{ kind: "tool_call", id: "a", name: "read", inputJson: "{}" }]), 1),
      ev("tool.result", { callId: "a", status: "ok", output: "ok" }, 1),
      ev("system.injected", { text: "and also do x", reason: "queued-messages", delivery: "reminder-block" }, 1),
    ];
    renders(events);
  });

  // spec: AC-LOOP-11
  test("two queued messages arrive together after the tool_result parts", () => {
    const q = new InputQueue();
    q.queue({ text: "first", attachments: [] });
    q.queue({ text: "second", attachments: [] });
    const parts = attachQueuedAfterResults(
      [
        { kind: "tool_result", callId: "a", isError: false, content: [{ kind: "text", text: "1" }] },
        { kind: "tool_result", callId: "b", isError: false, content: [{ kind: "text", text: "2" }] },
      ],
      q.takeAll(),
    );
    expect(parts.map((p) => p.kind)).toEqual(["tool_result", "tool_result", "text", "text"]);
    const texts = parts.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(texts).toEqual(["first", "second"]);
  });

  // spec: AC-LOOP-05
  test("queue disposition: input box when interactive, next turn when headless", () => {
    expect(queuedDisposition("interactive")).toBe("input-box");
    expect(queuedDisposition("headless")).toBe("next-turn");
    expect(startsNextTurnImmediately("end_turn", true)).toBe(true);
    expect(startsNextTurnImmediately("end_turn", false)).toBe(false);
    expect(startsNextTurnImmediately("error", true)).toBe(false);
    const q = new InputQueue();
    q.queue({ text: "steer", attachments: [] });
    const back = q.pullBackForEdit();
    expect(back.map((m) => m.text)).toEqual(["steer"]);
    expect(q.size).toBe(0);
    expect(ctrlEnterOutcome()).toEqual({ interrupt: true, keepCompleted: true, deliverImmediately: true });
    expect(queuedAsNextMessage([{ text: "a", attachments: [] }]).map((p) => p.kind)).toEqual(["text"]);
    expect(
      queuedAsNextMessage([
        { text: "a", attachments: [] },
        { text: "", attachments: [] },
      ]).map((p) => p.kind),
    ).toEqual(["text"]);
    expect(secondPressExits(0, 999)).toBe(true);
    expect(secondPressExits(0, 1000)).toBe(false);
  });

  // spec: AC-LOOP-05
  test("queued attachments travel with the message instead of being dropped", () => {
    const image = {
      kind: "image" as const,
      blob: { store: "blob" as const, id: "0".repeat(64) },
      mediaType: "image/png" as const,
    };
    const q = new InputQueue();
    q.queue({ text: "look at this", attachments: [image] });
    const back = q.pullBackForEdit();
    expect(back).toHaveLength(1);
    expect(back[0]?.attachments).toEqual([image]);
    q.queue({ text: "look at this", attachments: [image] });
    const parts = attachQueuedAfterResults(
      [{ kind: "tool_result", callId: "a", isError: false, content: [{ kind: "text", text: "ok" }] }],
      q.takeAll(),
    );
    expect(parts.map((p) => p.kind)).toEqual(["tool_result", "text", "image"]);
    const kept = parts.at(-1);
    expect(kept).toEqual(image);
    const q2 = new InputQueue();
    q2.queue({ text: "", attachments: [image] });
    expect(
      q2
        .takeAll()
        .flatMap((m) => queuedTextParts([m]))
        .map((p) => p.kind),
    ).toEqual(["image"]);
  });

  // spec: AC-LOOP-02
  test("TOOLS keeps finished results and marks only the rest interrupted", () => {
    const finished = [
      {
        callId: "a",
        name: "read",
        output: { status: "ok" as const, content: [{ kind: "text" as const, text: "real" }] },
        invalid: false,
      },
    ];
    const merged = mergeToolsInterrupt(finished, [
      { id: "a", name: "read", rawJson: "{}" },
      { id: "b", name: "read", rawJson: "{}" },
    ]);
    expect(merged.map((r) => r.callId)).toEqual(["a", "b"]);
    expect(merged[0]?.output.status).toBe("ok");
    const interrupted = merged[1]?.output.content[0];
    expect(interrupted !== undefined && interrupted.kind === "text" ? interrupted.text : "").toBe(
      INTERRUPTED_TOOL_TEXT,
    );
  });
});

describe("harness messages", () => {
  test("silence reminder fires after five silent tool steps, at most twice", () => {
    const t = new SilenceTracker();
    for (let i = 0; i < 4; i++) expect(t.noteStep(false)).toBeNull();
    const first = t.noteStep(false);
    expect(first?.reason).toBe("silence-reminder");
    for (let i = 0; i < 4; i++) t.noteStep(false);
    expect(t.noteStep(false)?.reason).toBe("silence-reminder");
    for (let i = 0; i < 5; i++) t.noteStep(false);
    expect(t.noteStep(false)).toBeNull();
    t.resetTurn();
    expect(t.noteStep(true)).toBeNull();
  });

  test("open-tasks continues headless only, twice, then ends incomplete", () => {
    expect(
      shouldContinueForOpenTasks({
        headless: false,
        endedWithText: true,
        openItems: 1,
        blockerStated: false,
        continuations: 0,
      }),
    ).toBe(false);
    expect(
      shouldContinueForOpenTasks({
        headless: true,
        endedWithText: true,
        openItems: 2,
        blockerStated: false,
        continuations: 0,
      }),
    ).toBe(true);
    expect(
      shouldContinueForOpenTasks({
        headless: true,
        endedWithText: true,
        openItems: 2,
        blockerStated: false,
        continuations: 2,
      }),
    ).toBe(false);
    expect(
      shouldContinueForOpenTasks({
        headless: true,
        endedWithText: true,
        openItems: 1,
        blockerStated: true,
        continuations: 0,
      }),
    ).toBe(false);
    expect(
      shouldContinueForOpenTasks({
        headless: true,
        endedWithText: false,
        openItems: 1,
        blockerStated: false,
        continuations: 0,
      }),
    ).toBe(false);
  });
});

describe("signals and shutdown", () => {
  test("exit codes and double-press behavior", () => {
    expect(EXIT_SIGINT).toBe(130);
    expect(EXIT_SIGTERM).toBe(143);
    expect(EXIT_SIGHUP).toBe(129);
    expect(EXIT_CRASH).toBe(70);
    expect(exitCodeForSignal("SIGINT")).toBe(130);
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
    expect(exitCodeForSignal("SIGHUP")).toBe(129);
    expect(exitCodeForSignal("SIGBREAK")).toBe(143);
    expect(secondSignalExits(0, 999)).toBe(true);
    expect(secondSignalExits(0, 1000)).toBe(false);
    expect(sigintOutcome({ first: true, withinWindow: false })).toEqual({ action: "interrupt" });
    expect(sigintOutcome({ first: false, withinWindow: true })).toEqual({ action: "exit", exitCode: 130 });
    expect(mustRestoreTerminalFirst("SIGTSTP")).toBe(true);
    expect(mustRestoreTerminalFirst("crash")).toBe(true);
    expect(mustRestoreTerminalFirst("SIGCONT")).toBe(false);
    expect(toolsKeepRunningOnTstp()).toBe(true);
  });

  test("shutdown writes no synthetic results", () => {
    expect(shutdownPlan("SIGTERM")).toEqual({
      killChildTrees: true,
      flushAndFsyncLog: true,
      releaseLock: true,
      writeSyntheticResults: false,
      exitCode: 143,
    });
    expect(shutdownPlan("SIGHUP").exitCode).toBe(129);
  });

  test("crash report holds types only, never content", () => {
    const report = buildCrashReport({
      stack: "Error: boom\n at x",
      versions: { dovet: "0.1.0", os: "linux" },
      eventTypes: [...Array.from({ length: 60 }, (_, i) => `user.message:${i}`), "model.response", "tool.result"],
    });
    expect(report.text).toContain("boom");
    expect(report.text).not.toContain("user.message:0 secret");
    const parsed = JSON.parse(report.text) as { eventTypes: string[] };
    expect(parsed.eventTypes).toHaveLength(50);
  });

  // spec: AC-LOOP-09
  test("SIGTERM during a running tool kills the tree, flushes the log and releases the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-sigterm-"));
    try {
      const os: Os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
      const core = createPlatformCore({
        os,
        arch: "x64",
        execPath: process.execPath,
        env: {},
        projectRoot: dir as never,
        kill: (pid, signal) => process.kill(pid, signal),
      });
      const controller = new AbortController();
      const child = core.spawn({
        argv: [process.execPath, "-e", "await new Promise((r) => setTimeout(r, 30000))"],
        cwd: dir,
        env: {},
        group: "session",
        signal: controller.signal,
      });
      expect(child.pid).toBeGreaterThan(0);
      const loc = {
        data: join(dir, "data"),
        projectRoot: dir,
        os,
        session: sequentialIds("7").ulid(),
      };
      const opened = await openSession({
        ...loc,
        clock: fakeClock(0),
        ids: sequentialIds("1"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error(opened.reason);
      opened.writer.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "go" } });
      const plan = shutdownPlan("SIGTERM");
      expect(plan.exitCode).toBe(143);
      await core.killTree("session");
      await opened.writer.flush();
      await opened.writer.close();
      let alive = true;
      try {
        process.kill(child.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
      const read = await readSession(loc);
      expect(read.readOnly).toBeUndefined();
      expect(read.events.some((e) => e.type === "user.message")).toBe(true);
      const reopened = await openSession({
        ...loc,
        clock: fakeClock(1),
        ids: sequentialIds("2"),
        pid: 2,
        host: "h",
        secrets: [],
      });
      expect(reopened.mode).toBe("write");
      if (reopened.mode === "write") await reopened.writer.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
