// Agent loop tests (agent-loop "Turn state machine", "Stop-reason handling", "Tool execution within a turn", "Loop and runaway protection").
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createPlatformCore } from "../platform/index.ts";
import { Settings } from "../schema/index.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "../tools/index.ts";
import { createReadState, createToolRegistry } from "../tools/index.ts";

function context(cwd: string, over: Partial<ToolContext> = {}): ToolContext {
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
    ...over,
  };
}

import {
  buildLoopContext,
  cacheStatusText,
  checkPairing,
  decideStopAction,
  executeTools,
  fileChangeEvents,
  fingerprintOf,
  GuardTracker,
  historyRepairOffer,
  INTERRUPTED_NOT_RUN,
  interruptResults,
  isDoomedRepeat,
  isEarlyEligible,
  isOverCap,
  malformedPauseMessage,
  modelRequestData,
  NOT_RUN_STOPPED,
  parseToolCalls,
  partitionCalls,
  REQUEST_CAP_BYTES,
  requestCapFor,
  shellStatusLine,
  shellToolFor,
  shouldDiscardEarly,
  shutdownResults,
  sizeGuardText,
  TRUNCATED_INSTRUCTION,
} from "./loop.ts";

function toolDef(name: string, parallelSafe: boolean, run?: ToolDefinition<unknown>["run"]): ToolDefinition<unknown> {
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
    run: run ?? (() => Promise.resolve({ status: "ok", content: [{ kind: "text", text: `${name} ok` }] })),
  };
}

const storedParts = (calls: Array<{ id: string; name: string; input: unknown }>) => ({
  provider: "nvidia",
  protocol: "openai-chat" as const,
  package: "@ai-sdk/openai-compatible",
  packageVersion: "1",
  modelId: "m",
  parts: calls.map((c) => ({ kind: "tool_call" as const, id: c.id, name: c.name, inputJson: JSON.stringify(c.input) })),
  usage: {},
  finishReason: "tool_calls",
});

describe("stop reasons", () => {
  // spec: AC-LOOP-01
  test("every stop reason maps to the table action", () => {
    expect(
      decideStopAction({
        stop: "end_turn",
        toolCalls: 0,
        hasText: true,
        emptyOrThinkingOnly: false,
        truncatedToolCall: false,
        pauseContinuations: 0,
        emptyRetries: 0,
        refusalRetries: 0,
      }).kind,
    ).toBe("finalize");
    expect(
      decideStopAction({
        stop: "tool_use",
        toolCalls: 1,
        hasText: false,
        emptyOrThinkingOnly: false,
        truncatedToolCall: false,
        pauseContinuations: 0,
        emptyRetries: 0,
        refusalRetries: 0,
      }),
    ).toEqual({ kind: "tools" });
    const truncated = decideStopAction({
      stop: "max_tokens",
      toolCalls: 1,
      hasText: false,
      emptyOrThinkingOnly: false,
      truncatedToolCall: true,
      pauseContinuations: 0,
      emptyRetries: 0,
      refusalRetries: 0,
    });
    expect(truncated).toEqual({ kind: "prepare", instruction: TRUNCATED_INSTRUCTION });
    const maxNoTool = decideStopAction({
      stop: "max_tokens",
      toolCalls: 0,
      hasText: true,
      emptyOrThinkingOnly: false,
      truncatedToolCall: false,
      pauseContinuations: 0,
      emptyRetries: 0,
      refusalRetries: 0,
    });
    expect(maxNoTool.kind).toBe("finalize");
    expect(
      decideStopAction({
        stop: "context_exceeded",
        toolCalls: 0,
        hasText: false,
        emptyOrThinkingOnly: false,
        truncatedToolCall: false,
        pauseContinuations: 0,
        emptyRetries: 0,
        refusalRetries: 0,
      }),
    ).toEqual({ kind: "compact-retry" });
    expect(
      decideStopAction({
        stop: "refusal",
        toolCalls: 1,
        hasText: false,
        emptyOrThinkingOnly: false,
        truncatedToolCall: false,
        pauseContinuations: 0,
        emptyRetries: 0,
        refusalRetries: 0,
      }).kind,
    ).toBe("finalize");
    expect(
      decideStopAction({
        stop: "pause",
        toolCalls: 0,
        hasText: false,
        emptyOrThinkingOnly: false,
        truncatedToolCall: false,
        pauseContinuations: 0,
        emptyRetries: 0,
        refusalRetries: 0,
      }),
    ).toEqual({ kind: "pause-continue" });
    expect(
      decideStopAction({
        stop: "pause",
        toolCalls: 0,
        hasText: false,
        emptyOrThinkingOnly: false,
        truncatedToolCall: false,
        pauseContinuations: 5,
        emptyRetries: 0,
        refusalRetries: 0,
      }).kind,
    ).toBe("finalize");
    const seq = decideStopAction({
      stop: "stop_sequence",
      toolCalls: 0,
      hasText: false,
      emptyOrThinkingOnly: false,
      truncatedToolCall: false,
      pauseContinuations: 0,
      emptyRetries: 0,
      refusalRetries: 0,
    });
    expect(seq.kind).toBe("finalize");
    const other = decideStopAction({
      stop: { other: "weird" },
      toolCalls: 0,
      hasText: false,
      emptyOrThinkingOnly: false,
      truncatedToolCall: false,
      pauseContinuations: 0,
      emptyRetries: 0,
      refusalRetries: 0,
    });
    expect(other.kind).toBe("finalize");
    expect(
      decideStopAction({
        stop: "end_turn",
        toolCalls: 0,
        hasText: false,
        emptyOrThinkingOnly: true,
        truncatedToolCall: false,
        pauseContinuations: 0,
        emptyRetries: 0,
        refusalRetries: 0,
      }),
    ).toEqual({ kind: "retry" });
    expect(
      decideStopAction({
        stop: "end_turn",
        toolCalls: 0,
        hasText: false,
        emptyOrThinkingOnly: true,
        truncatedToolCall: false,
        pauseContinuations: 0,
        emptyRetries: 1,
        refusalRetries: 0,
      }),
    ).toEqual({ kind: "finalize", reason: "end_turn", note: "The model returned no answer." });
  });

  // spec: AC-LOOP-01
  test("refusal before output retries once unless billed", () => {
    const base = {
      stop: "refusal" as const,
      toolCalls: 0,
      hasText: false,
      emptyOrThinkingOnly: false,
      truncatedToolCall: false,
      pauseContinuations: 0,
      emptyRetries: 0,
    };
    expect(
      decideStopAction({ ...base, refusalCategory: "general_harms", refusalBeforeOutput: true, refusalRetries: 0 })
        .kind,
    ).toBe("retry");
    expect(
      decideStopAction({ ...base, refusalCategory: "general_harms", refusalBeforeOutput: true, refusalRetries: 1 })
        .kind,
    ).toBe("finalize");
    for (const billed of ["bio", "frontier_llm", "reasoning_extraction"]) {
      expect(
        decideStopAction({ ...base, refusalCategory: billed, refusalBeforeOutput: true, refusalRetries: 0 }).kind,
      ).toBe("finalize");
    }
  });

  // spec: AC-LOOP-01
  test("tool_use/result pairing is asserted in order", () => {
    expect(checkPairing(["a", "b"], ["a", "b"])).toBeNull();
    expect(checkPairing(["a", "b"], ["b", "a"])).toContain("mismatch");
    expect(checkPairing(["a"], [])).toContain("expected 1");
  });
});

describe("batching and ordering", () => {
  // spec: AC-LOOP-03
  test("parallel-safe runs group, mutating runs alone", () => {
    const calls = [
      { parallelSafe: true },
      { parallelSafe: true },
      { parallelSafe: true },
      { parallelSafe: false },
      { parallelSafe: true },
      { parallelSafe: true },
    ];
    expect(partitionCalls(calls)).toEqual([[0, 1, 2], [3], [4, 5]]);
  });

  // spec: AC-LOOP-03
  test("ten parallel-safe calls split at eight", () => {
    const calls = Array.from({ length: 10 }, () => ({ parallelSafe: true }));
    expect(partitionCalls(calls)).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
      [8, 9],
    ]);
  });

  // spec: AC-LOOP-03
  test("3 Reads + Edit + 2 Greps keep emitted order in one message", async () => {
    const order: string[] = [];
    const running = { n: 0, max: 0 };
    const mkRun =
      (name: string, ms: number): ToolDefinition<unknown>["run"] =>
      async () => {
        running.n += 1;
        running.max = Math.max(running.max, running.n);
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, ms));
        running.n -= 1;
        order.push(`end:${name}`);
        return { status: "ok", content: [{ kind: "text", text: name }] };
      };
    const registry = createToolRegistry([
      toolDef("Read", true, mkRun("Read", 20)),
      toolDef("Edit", false, mkRun("Edit", 5)),
      toolDef("Grep", true, mkRun("Grep", 20)),
    ]);
    const base = context(await mkdtemp(join(tmpdir(), "dovet-loop-")));
    const calls = parseToolCalls(
      storedParts([
        { id: "r1", name: "Read", input: {} },
        { id: "r2", name: "Read", input: {} },
        { id: "r3", name: "Read", input: {} },
        { id: "e1", name: "Edit", input: {} },
        { id: "g1", name: "Grep", input: {} },
        { id: "g2", name: "Grep", input: {} },
      ]).parts,
    );
    const { results, stopped } = await executeTools(calls, {
      registry,
      decide: () => ({ behavior: "allow", reason: "test" }),
      prompt: () => Promise.resolve({ allow: true, dontAskAgain: false }),
      run: (tool, input, ctx) => (tool.run as (i: unknown, c: ToolContext) => Promise<ToolOutput>)(input, ctx),
      makeContext: () => base,
      offloadDir: join(tmpdir(), "dovet-loop-off"),
    });
    expect(stopped).toBe(false);
    expect(results.map((r) => r.callId)).toEqual(["r1", "r2", "r3", "e1", "g1", "g2"]);
    expect(results.map((r) => (r.output.content[0] as { text: string }).text)).toEqual([
      "Read",
      "Read",
      "Read",
      "Edit",
      "Grep",
      "Grep",
    ]);
    expect(running.max).toBeGreaterThan(1);
    await rm(base.session.cwd, { recursive: true, force: true });
  });
});

describe("truncation and strict parsing", () => {
  // spec: AC-LOOP-04
  test("max_tokens with a tool call never executes", () => {
    const action = decideStopAction({
      stop: "max_tokens",
      toolCalls: 1,
      hasText: false,
      emptyOrThinkingOnly: false,
      truncatedToolCall: true,
      pauseContinuations: 0,
      emptyRetries: 0,
      refusalRetries: 0,
    });
    expect(action).toEqual({ kind: "prepare", instruction: TRUNCATED_INSTRUCTION });
    expect(action.kind).not.toBe("tools");
  });

  // spec: AC-LOOP-04
  test("tool input JSON is parsed strictly without escape repair", async () => {
    const registry = createToolRegistry([toolDef("Read", true)]);
    const base = context(await mkdtemp(join(tmpdir(), "dovet-loop-")));
    let ran = 0;
    const { results } = await executeTools(
      [{ id: "a", name: "Read", rawJson: '{"file_path": "C:\\Users\\unicorn"}' }],
      {
        registry,
        decide: () => ({ behavior: "allow", reason: "t" }),
        prompt: () => Promise.resolve({ allow: true, dontAskAgain: false }),
        run: () => {
          ran += 1;
          return Promise.resolve({ status: "ok", content: [] });
        },
        makeContext: () => base,
        offloadDir: join(tmpdir(), "dovet-loop-off"),
      },
    );
    expect(ran).toBe(0);
    const first = results[0];
    expect(first?.invalid).toBe(true);
    const firstText = first?.output.content[0];
    expect(firstText !== undefined && firstText.kind === "text" ? firstText.text : "").toContain("INVALID_JSON");
    await rm(base.session.cwd, { recursive: true, force: true });
  });
});

describe("no cascade and single prompt", () => {
  // spec: AC-LOOP-12
  test("a failing Bash still runs every other call", async () => {
    const registry = createToolRegistry([
      toolDef("Read", true),
      toolDef("Bash", false, () => Promise.resolve({ status: "error", content: [{ kind: "text", text: "boom" }] })),
      toolDef("Grep", true),
    ]);
    const base = context(await mkdtemp(join(tmpdir(), "dovet-loop-")));
    const calls = parseToolCalls(
      storedParts([
        { id: "a", name: "Read", input: {} },
        { id: "b", name: "Bash", input: {} },
        { id: "c", name: "Grep", input: {} },
      ]).parts,
    );
    const { results } = await executeTools(calls, {
      registry,
      decide: () => ({ behavior: "allow", reason: "t" }),
      prompt: () => Promise.resolve({ allow: true, dontAskAgain: false }),
      run: (tool, input, ctx) => (tool.run as (i: unknown, c: ToolContext) => Promise<ToolOutput>)(input, ctx),
      makeContext: () => base,
      offloadDir: join(tmpdir(), "dovet-loop-off"),
    });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.callId)).toEqual(["a", "b", "c"]);
    const boom = results[1]?.output.content[0];
    expect(boom !== undefined && boom.kind === "text" ? boom.text : "").toBe("boom");
    await rm(base.session.cwd, { recursive: true, force: true });
  });

  // spec: AC-LOOP-12
  test("two identical approval calls prompt once on don't ask again", async () => {
    const registry = createToolRegistry([toolDef("Bash", false)]);
    const base = context(await mkdtemp(join(tmpdir(), "dovet-loop-")));
    let allowed = false;
    let prompts = 0;
    const calls = parseToolCalls(
      storedParts([
        { id: "a", name: "Bash", input: {} },
        { id: "b", name: "Bash", input: {} },
      ]).parts,
    );
    const { results, prompted } = await executeTools(calls, {
      registry,
      decide: () => (allowed ? { behavior: "allow", reason: "granted" } : { behavior: "ask", reason: "ask" }),
      prompt: () => {
        prompts += 1;
        allowed = true;
        return Promise.resolve({ allow: true, dontAskAgain: true });
      },
      run: (tool, input, ctx) => (tool.run as (i: unknown, c: ToolContext) => Promise<ToolOutput>)(input, ctx),
      makeContext: () => base,
      offloadDir: join(tmpdir(), "dovet-loop-off"),
    });
    expect(prompts).toBe(1);
    expect(prompted).toBe(1);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.output.status === "ok")).toBe(true);
    await rm(base.session.cwd, { recursive: true, force: true });
  });

  // spec: AC-LOOP-12
  test("a No without comment stops the turn", async () => {
    const registry = createToolRegistry([toolDef("Bash", false), toolDef("Read", true)]);
    const base = context(await mkdtemp(join(tmpdir(), "dovet-loop-")));
    const calls = parseToolCalls(
      storedParts([
        { id: "a", name: "Bash", input: {} },
        { id: "b", name: "Read", input: {} },
      ]).parts,
    );
    const { results, stopped } = await executeTools(calls, {
      registry,
      decide: () => ({ behavior: "ask", reason: "ask" }),
      prompt: () => Promise.resolve({ allow: false, dontAskAgain: false }),
      run: (tool, input, ctx) => (tool.run as (i: unknown, c: ToolContext) => Promise<ToolOutput>)(input, ctx),
      makeContext: () => base,
      offloadDir: join(tmpdir(), "dovet-loop-off"),
    });
    expect(stopped).toBe(true);
    const stoppedText = results[1]?.output.content[0];
    expect(stoppedText !== undefined && stoppedText.kind === "text" ? stoppedText.text : "").toBe(NOT_RUN_STOPPED);
    expect(INTERRUPTED_NOT_RUN).toContain("interrupted");
    await rm(base.session.cwd, { recursive: true, force: true });
  });
});

describe("guards", () => {
  // spec: AC-LOOP-06
  test("max requests pauses and continue resets", () => {
    const g = new GuardTracker();
    g.requests = 150;
    g.cost = 4.2;
    const pause = g.beforeRequest("body", false);
    expect("pause" in pause && pause.pause.guard).toBe("max-requests");
    g.resetForContinue();
    expect(g.beforeRequest("body", false)).toEqual({ doomed: false });
  });

  // spec: AC-LOOP-06
  test("identical failing calls pause at three", () => {
    const g = new GuardTracker();
    expect(g.noteIdenticalFail("Bash({})", "boom")).toBeNull();
    expect(g.noteIdenticalFail("Bash({})", "boom")).toBeNull();
    expect(g.noteIdenticalFail("Bash({})", "boom")?.guard).toBe("identical-failing");
    g.noteIdenticalSuccess();
    expect(g.noteIdenticalFail("Bash({})", "boom")).toBeNull();
  });

  // spec: AC-LOOP-06
  test("no progress pauses at 25 and progress resets", () => {
    const g = new GuardTracker();
    for (let i = 0; i < 24; i++) expect(g.noteProgress(false)).toBeNull();
    expect(g.noteProgress(false)?.guard).toBe("no-progress");
    expect(g.noteProgress(true)).toBeNull();
  });

  // spec: AC-LOOP-14
  test("three malformed rounds pause with the spec message", () => {
    const g = new GuardTracker();
    expect(g.noteMalformedRound(true, "INVALID_JSON", false, "m")).toBeNull();
    expect(g.noteMalformedRound(true, "INVALID_JSON", false, "m")).toBeNull();
    const pause = g.noteMalformedRound(true, "INVALID_JSON", false, "m");
    expect(pause?.guard).toBe("malformed");
    expect(pause?.message).toBe(malformedPauseMessage("m", "INVALID_JSON", false));
    expect(pause?.message).toContain("/model");
  });

  // spec: AC-LOOP-14
  test("all-truncated names the output limit instead", () => {
    expect(malformedPauseMessage("m", "cut off", true)).toContain("output limit");
  });

  // spec: AC-LOOP-14
  test("a mixed streak names the model, not the output limit", () => {
    const g = new GuardTracker();
    expect(g.noteMalformedRound(true, "INVALID_JSON", false, "m")).toBeNull();
    expect(g.noteMalformedRound(true, "cut off", true, "m")).toBeNull();
    const pause = g.noteMalformedRound(true, "cut off", true, "m");
    expect(pause?.guard).toBe("malformed");
    expect(pause?.message).toContain("/model");
    expect(pause?.message).not.toContain("output limit");
    const h = new GuardTracker();
    expect(h.noteMalformedRound(true, "cut off", true, "m")).toBeNull();
    expect(h.noteMalformedRound(true, "cut off", true, "m")).toBeNull();
    expect(h.noteMalformedRound(true, "cut off", true, "m")?.message).toContain("output limit");
  });

  // spec: AC-LOOP-14
  test("a byte-identical request after a non-retryable error is never sent", () => {
    expect(isDoomedRepeat("abc", false, "abc")).toBe(true);
    expect(isDoomedRepeat("abc", true, "abc")).toBe(false);
    expect(isDoomedRepeat("abc", false, "abd")).toBe(false);
    const g = new GuardTracker();
    g.noteRequestSent("abc");
    g.noteError(false);
    expect(g.beforeRequest("abc", false)).toEqual({ doomed: true });
  });

  // spec: AC-LOOP-14
  test("shutdown writes no synthetic results while interrupt does", () => {
    expect(shutdownResults()).toEqual([]);
    expect(interruptResults([{ id: "a", name: "Bash", rawJson: "{}" }])).toHaveLength(1);
  });
});

describe("request size, early tools, model.request and cache", () => {
  // spec: AC-LOOP-12
  test("over 90% of the cap is replaced with a smaller-read message", () => {
    expect(isOverCap(31_000_000, REQUEST_CAP_BYTES)).toBe(true);
    expect(isOverCap(1_000, REQUEST_CAP_BYTES)).toBe(false);
    expect(sizeGuardText(99)).toContain("/compact");
    expect(requestCapFor("nvidia")).toBe(REQUEST_CAP_BYTES);
    expect(requestCapFor("bedrock")).toBeLessThan(REQUEST_CAP_BYTES);
  });

  // spec: AC-LOOP-12
  test("an oversized tool result is replaced before it is appended", async () => {
    const registry = createToolRegistry([toolDef("Read", true)]);
    const base = context(await mkdtemp(join(tmpdir(), "dovet-loop-")));
    const calls = parseToolCalls(storedParts([{ id: "a", name: "Read", input: {} }]).parts);
    const { results } = await executeTools(calls, {
      registry,
      decide: () => ({ behavior: "allow", reason: "t" }),
      prompt: () => Promise.resolve({ allow: true, dontAskAgain: false }),
      run: () => Promise.resolve({ status: "ok", content: [{ kind: "text", text: "x".repeat(1000) }] }),
      makeContext: () => base,
      offloadDir: join(tmpdir(), "dovet-loop-off"),
      capBytes: 1000,
    });
    expect(results[0]?.output.status).toBe("error");
    const text = results[0]?.output.content[0];
    expect(text !== undefined && text.kind === "text" ? text.text : "").toContain("/compact");
    await rm(base.session.cwd, { recursive: true, force: true });
  });

  // spec: AC-LOOP-03
  test("early results are reused without running the tool again", async () => {
    const registry = createToolRegistry([toolDef("Read", true)]);
    const base = context(await mkdtemp(join(tmpdir(), "dovet-loop-")));
    let runs = 0;
    const early: ToolOutput = { status: "ok", content: [{ kind: "text", text: "early" }] };
    const calls = parseToolCalls(storedParts([{ id: "a", name: "Read", input: {} }]).parts);
    const { results } = await executeTools(calls, {
      registry,
      decide: () => ({ behavior: "allow", reason: "t" }),
      prompt: () => Promise.resolve({ allow: true, dontAskAgain: false }),
      run: () => {
        runs += 1;
        return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "late" }] });
      },
      makeContext: () => base,
      offloadDir: join(tmpdir(), "dovet-loop-off"),
      earlyResults: new Map([["a", early]]),
    });
    expect(runs).toBe(0);
    const text = results[0]?.output.content[0];
    expect(text !== undefined && text.kind === "text" ? text.text : "").toBe("early");
    expect(shouldDiscardEarly("refusal", false)).toBe(true);
    expect(shouldDiscardEarly("max_tokens", true)).toBe(true);
    expect(shouldDiscardEarly("max_tokens", false)).toBe(false);
    expect(shouldDiscardEarly("tool_use", true)).toBe(false);
    expect(shouldDiscardEarly("tool_use", false)).toBe(false);
    await rm(base.session.cwd, { recursive: true, force: true });
  });

  // spec: AC-LOOP-03
  test("only local reads start early and only on allow", () => {
    expect(isEarlyEligible("Read", "allow")).toBe(true);
    expect(isEarlyEligible("Grep", "allow")).toBe(true);
    expect(isEarlyEligible("Glob", "allow")).toBe(true);
    expect(isEarlyEligible("Bash", "allow")).toBe(false);
    expect(isEarlyEligible("Read", "ask")).toBe(false);
  });

  // spec: AC-CTX-04
  test("model.request carries the body hash and fingerprint; cache drops warn", () => {
    const fp = fingerprintOf({ messages: [{ role: "system", content: "s" }], tools: [] });
    const data = modelRequestData({
      provider: "nvidia",
      model: "m",
      maxTokens: 100,
      messageCount: 2,
      body: "{}",
      fingerprint: fp,
    });
    expect(data.bodySha256).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(data.fingerprint).toEqual(fp);
    expect(data.fingerprint.messages).toHaveLength(0);
    const warn = cacheStatusText({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: 0 });
    expect(warn?.text).toContain("8000");
    expect(warn?.invariant).toEqual({ kind: "cache-read-drop", turn: 5, previous: 8000, current: 0 });
  });

  // spec: AC-LOOP-06
  test("compaction thrash stops after three at-threshold compactions", () => {
    const g = new GuardTracker();
    expect(g.noteCompaction(true)).toBeNull();
    expect(g.noteCompaction(true)).toBeNull();
    expect(g.noteCompaction(true)?.guard).toBe("compaction-thrash");
    expect(g.noteCompaction(false)).toBeNull();
  });

  // spec: AC-LOOP-03
  test("loop context carries read results and free tokens", () => {
    const base = context("/tmp");
    const withCtx = buildLoopContext({ base, events: [], epoch: 0, contextFreeTokens: 42 });
    expect(withCtx.contextFreeTokens).toBe(42);
    expect(withCtx.readResults.lookup({ file_path: "/x" })).toBeUndefined();
    expect(createReadState("linux").get("/nope")).toBeUndefined();
  });

  // spec: AC-LOOP-03
  test("file.change events come from meta.fileChanges", () => {
    const out: ToolOutput = {
      status: "ok",
      content: [{ kind: "text", text: "x" }],
      meta: { fileChanges: [{ path: "/a" as never, op: "create", added: 1, removed: 0 }] },
    };
    expect(fileChangeEvents([{ callId: "a", name: "Write", output: out, invalid: false }])).toHaveLength(1);
  });

  // spec: AC-LOOP-01
  test("shell selection and status show fallback and language mode", () => {
    expect(shellToolFor(undefined, tmpdir()).name).toBe("Bash");
    expect(shellToolFor({ kind: "git-bash", path: "/bin/bash" as never }, tmpdir()).name).toBe("Bash");
    expect(shellStatusLine({ choice: undefined, parsers: false })).toContain("fallback");
    expect(shellStatusLine({ choice: undefined, parsers: true, languageMode: "FullLanguage" })).toContain(
      "FullLanguage",
    );
  });
});

describe("repair epoch offer", () => {
  // spec: AC-LOG-12
  test("a history rejection offers the repair epoch with the resume hint", () => {
    expect(
      historyRepairOffer({ kind: "invalid_request", retryable: false, message: "replay failed: empty text block" }),
    ).toEqual({
      offer: "Repair: continue in a new epoch built from the normalized transcript",
      hint: "dovet --resume <id> --repair",
    });
  });

  // spec: AC-LOG-12
  test("other failures offer nothing", () => {
    expect(historyRepairOffer({ kind: "server", retryable: true, message: "overloaded" })).toBeNull();
    expect(historyRepairOffer({ kind: "invalid_request", retryable: false, message: "schema too complex" })).toBeNull();
  });
});

describe("tool-result output guard", () => {
  async function guarded(text: string, secrets: Array<{ name: string; value: string }> = []) {
    const registry = createToolRegistry([toolDef("Bash", true)]);
    const base = context(await mkdtemp(join(tmpdir(), "dovet-loop-")));
    try {
      const calls = parseToolCalls(storedParts([{ id: "a", name: "Bash", input: {} }]).parts);
      const { results } = await executeTools(calls, {
        registry,
        decide: () => ({ behavior: "allow", reason: "t" }),
        prompt: () => Promise.resolve({ allow: true, dontAskAgain: false }),
        run: () => Promise.resolve({ status: "ok", content: [{ kind: "text", text }] }),
        makeContext: () => base,
        offloadDir: join(tmpdir(), "dovet-loop-off"),
        secrets: () => secrets,
      });
      return results[0]?.output;
    } finally {
      await rm(base.session.cwd, { recursive: true, force: true });
    }
  }

  const textOf = (output: ToolOutput | undefined): string =>
    output?.content.map((c) => (c.kind === "text" ? c.text : "")).join("") ?? "";

  // spec: AC-PERM-30
  test("secret values and key formats are redacted before the model and the log", async () => {
    const output = await guarded("token rk-live-example-0001-fakevalue and sk-ant-example-fake-key-000004", [
      { name: "STRIPE_SECRET_KEY", value: "rk-live-example-0001-fakevalue" },
    ]);
    expect(textOf(output)).toBe("token [REDACTED:STRIPE_SECRET_KEY] and [REDACTED:ANTHROPIC_KEY]");
  });

  // spec: AC-PERM-26
  test("hidden characters are stripped from any tool result and taint the session", async () => {
    const output = await guarded("note: all \u{E0041}\u{E0042}good", []);
    const text = textOf(output);
    expect(text).toBe(
      "note: all ⟨2 hidden characters removed⟩good\n[2 hidden characters were removed from this result.]",
    );
    expect(output?.meta?.effects).toEqual([{ kind: "taint", source: "Bash result" }]);
  });

  // spec: AC-PERM-26
  test("ordinary multilingual text passes through the guard unchanged", async () => {
    const output = await guarded("متن فارسی با نیم‌فاصله and 👨‍👩‍👧‍👦", []);
    expect(textOf(output)).toBe("متن فارسی با نیم‌فاصله and 👨‍👩‍👧‍👦");
    expect(output?.meta?.effects ?? []).toEqual([]);
  });
});
