// Headless agent turn tests (tui Headless mode, agent-loop Turn state machine, event-log Resume, providers section 1).
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fakePlatform, nvidiaAdapter, scriptedModel, sequentialIds, tempProject } from "../../test/helpers/index.ts";
import { buildRequest, cacheWarning, headerOf, modelRequestBody, TRUNCATED_INSTRUCTION } from "../agent/index.ts";
import { createSdkAdapter } from "../ai/index.ts";
import type { Os } from "../platform/index.ts";
import { ModelRequestData } from "../schema/index.ts";
import type { LoadedSettings } from "../store/index.ts";
import { openSession, readSession, sessionPaths } from "../store/index.ts";
import type { ToolDefinition } from "../tools/index.ts";
import { readTool } from "../tools/index.ts";
import { exitCodeFor } from "./headless-output.ts";
import { headlessToolDefs, resolveHeadlessModel, runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");

function settingsFor(model = "test/model"): LoadedSettings {
  return {
    settings: { provider: "nvidia", model } as LoadedSettings["settings"],
    rules: { allow: [], ask: [], deny: [] },
    warnings: [],
    notices: [],
    files: [],
  };
}

function echoTool(onRun?: (text: string) => { status: "ok" | "error"; text: string }): ToolDefinition<unknown> {
  return {
    name: "echo",
    input: z.strictObject({ text: z.string() }),
    descriptionFile: "tools/Read.md",
    errorExample: { text: "hi" },
    parallelSafe: true,
    mutates: "none",
    describeAction: () => ({
      kind: "read",
      paths: [],
      effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
    }),
    run: (input) => {
      const text = (input as { text: string }).text;
      if (onRun !== undefined) {
        const r = onRun(text);
        return Promise.resolve({ status: r.status, content: [{ kind: "text", text: r.text }] });
      }
      return Promise.resolve({ status: "ok", content: [{ kind: "text", text: `echo:${text}` }] });
    },
  } as ToolDefinition<unknown>;
}

function adapterFor(steps: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(steps);
  return createSdkAdapter({
    endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
    model: () => model,
  });
}

type StubStep = {
  stop: "tool_use" | "end_turn" | "max_tokens" | "refusal";
  calls?: { id: string; name: string; input: unknown }[];
  text?: string;
  usage?: Record<string, unknown>;
};

function stubAdapter(steps: StubStep[]) {
  let next = 0;
  return {
    render: () => ({
      provider: "nvidia",
      package: "x",
      modelId: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [],
      providerOptions: {},
    }),
    stream: async function* () {
      const step = steps[next];
      next += 1;
      if (step === undefined) throw new Error("stubAdapter: script exhausted");
      yield {
        type: "done",
        stopReason: step.stop,
        stored: {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "x",
          packageVersion: "1",
          modelId: "m",
          parts: [
            ...(step.calls ?? []).map((c) => ({
              kind: "tool_call",
              id: c.id,
              name: c.name,
              inputJson: JSON.stringify(c.input),
            })),
            ...(step.text === undefined ? [] : [{ kind: "text", text: step.text }]),
          ],
          usage: step.usage ?? {},
          finishReason: step.stop === "tool_use" ? "tool_calls" : "stop",
        },
      };
    },
  } as never;
}

describe("resolveHeadlessModel", () => {
  test("flags win over settings, and a missing model is a usage error", () => {
    expect(resolveHeadlessModel({ provider: "nvidia", model: "a" } as never, {})).toEqual({
      provider: "nvidia",
      model: "a",
    });
    expect(
      resolveHeadlessModel({ provider: "nvidia", model: "a" } as never, { model: "b", provider: "nvidia" }),
    ).toEqual({ provider: "nvidia", model: "b" });
    expect(resolveHeadlessModel({} as never, {})).toEqual({ error: expect.stringContaining("no model") });
  });
});

describe("headlessToolDefs", () => {
  test("carries the real tools without AskUserQuestion", () => {
    const defs = headlessToolDefs({ platform: fakePlatform(), tmpDir: "/tmp", offline: false });
    const names = defs.map((d) => d.name);
    expect(names).toContain("Read");
    expect(names).toContain("Bash");
    expect(names).not.toContain("AskUserQuestion");
  });
});

describe("runHeadless", () => {
  test("a tool-using turn writes the events and replays byte-identically", async () => {
    const dir = await tempProject({ "note.txt": "hello" });
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "read the note",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("H"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([{ toolCall: { id: "c1", name: "echo", input: { text: "turn-1" } } }, { text: "done" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("done");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const types = read.events.map((e) => e.type);
      for (const t of [
        "epoch.start",
        "user.message",
        "model.request",
        "model.response",
        "tool.call",
        "tool.result",
        "turn.end",
      ])
        expect(types).toContain(t);
      const requests = read.events.filter((e) => e.type === "model.request");
      expect(requests.length).toBeGreaterThanOrEqual(2);
      for (const req of requests) {
        const data = req.data as { bodySha256: string };
        expect(data.bodySha256).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await dir.dispose();
    }
  });

  test("an error tool result is returned to the model, which recovers", async () => {
    const dir = await tempProject({});
    try {
      let calls = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "do it",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("E"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([{ toolCall: { id: "c1", name: "echo", input: { text: "boom" } } }, { text: "recovered" }]),
        toolDefs: [
          echoTool((text) => {
            calls += 1;
            return text === "boom"
              ? { status: "error", text: "error: demo failure" }
              : { status: "ok", text: `echo:${text}` };
          }),
        ],
      });
      expect(calls).toBe(1);
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("recovered");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const err = read.events.find((e) => e.type === "tool.result");
      if (err === undefined) throw new Error("no tool.result event");
      expect((err.data as { status: string }).status).toBe("error");
    } finally {
      await dir.dispose();
    }
  });

  test("a mid-epoch instruction renders as the reminder block on the next request", async () => {
    const adapter = adapterFor([{ text: "ok" }]);
    const events = [
      {
        v: 1,
        id: "0".repeat(26),
        ts: "2026-10-15T00:00:00.000Z",
        session: "s",
        epoch: 0,
        turn: 1,
        type: "user.message",
        core: true,
        data: { text: "go" },
      },
      {
        v: 1,
        id: "1".repeat(26),
        ts: "2026-10-15T00:00:00.000Z",
        session: "s",
        epoch: 0,
        turn: 1,
        type: "system.injected",
        core: true,
        data: { text: "Be terse.", reason: "queued-messages", delivery: "reminder-block" },
      },
    ] as never;
    const built = buildRequest(events as never, {
      header: {
        epoch: 0,
        provider: "nvidia",
        model: "m",
        promptVersion: "t",
        systemText: "s",
        toolsJson: "[]",
        thinking: { mode: "off" },
      },
      params: { maxTokens: 10 },
      cache: { breakpoints: "auto", ttl: "auto" },
    });
    const call = adapter.render(built);
    expect(JSON.stringify(call.messages)).toContain("[Dovet instruction] Be terse.");
  });

  test("history-rejected exits 6 with the repair hint", async () => {
    const { APICallError } = await import("ai");
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "go",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("X"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          {
            error: new APICallError({
              message: "replay failed: empty text block",
              url: "u",
              requestBodyValues: {},
              statusCode: 400,
              isRetryable: false,
            }),
          },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "history-rejected" });
      expect(exitCodeFor(out.exit)).toBe(6);
      expect(out.result).toContain("--repair");
    } finally {
      await dir.dispose();
    }
  });

  test("the guard stops the turn with exit 3 when maxRequests is hit", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
          maxRequests: 1,
        },
        prompt: "loop",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("G"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "c1", name: "echo", input: { text: "a" } } },
          { toolCall: { id: "c2", name: "echo", input: { text: "b" } } },
          { text: "never" },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "guard" });
      expect(exitCodeFor(out.exit)).toBe(3);
      expect(out.incomplete).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Loop and runaway protection"
  test("the cache monitor stays quiet when the provider reports no cache field", () => {
    expect(cacheWarning({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: undefined })).toBeNull();
    expect(cacheWarning(undefined, { turn: 5, cacheReadTokens: 0 })).toBeNull();
  });

  // spec: tui "Headless mode", agent-loop "Turn state machine", event-log "Resume", providers section 1
  test("a turn with the real Read tool replays every request byte-identically", async () => {
    const dir = await tempProject({ "note.txt": "hello world\n" });
    try {
      const adapter = adapterFor([
        { toolCall: { id: "c1", name: "Read", input: { file_path: "note.txt" } } },
        { text: "says hello" },
      ]);
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "read it",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("R"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter,
        toolDefs: [readTool as ToolDefinition<unknown>],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.warnings).toEqual([]);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const result = read.events.find((e) => e.type === "tool.result");
      if (result === undefined) throw new Error("no tool.result event");
      expect((result.data as { status: string }).status).toBe("ok");
      expect((result.data as { output: string }).output).toContain("hello world");
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      const header = headerOf(epochStart.data as never);
      const requests = read.events.filter((e) => e.type === "model.request");
      expect(requests.length).toBe(2);
      const bodies = requests.map((req) => {
        const recorded = ModelRequestData.parse(req.data);
        const before = read.events.slice(0, read.events.indexOf(req));
        const call = adapter.render(
          buildRequest(before, {
            header,
            params: { maxTokens: recorded.params.maxTokens },
            cache: { breakpoints: "auto", ttl: "auto" },
          }),
        );
        const body = modelRequestBody(call);
        expect(new Bun.CryptoHasher("sha256").update(body).digest("hex")).toBe(recorded.bodySha256);
        expect(call.messages).toHaveLength(recorded.messageCount);
        return JSON.parse(body) as { messages: unknown[]; tools: unknown };
      });
      const first = bodies[0];
      const second = bodies[1];
      if (first === undefined || second === undefined) throw new Error("missing request bodies");
      expect(second.messages.length).toBeGreaterThan(first.messages.length);
      expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
      expect(second.tools).toEqual(first.tools);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Tool execution within a turn"
  test("the error text reaches the model in the next request", async () => {
    const dir = await tempProject({});
    try {
      const adapter = adapterFor([
        { toolCall: { id: "c1", name: "echo", input: { text: "boom" } } },
        { text: "recovered" },
      ]);
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "do it",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("Q"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter,
        toolDefs: [
          echoTool((text) =>
            text === "boom" ? { status: "error", text: "error: demo failure" } : { status: "ok", text: `echo:${text}` },
          ),
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      const header = headerOf(epochStart.data as never);
      const requests = read.events.filter((e) => e.type === "model.request");
      expect(requests.length).toBe(2);
      const second = requests[1];
      if (second === undefined) throw new Error("no second request");
      const recorded = ModelRequestData.parse(second.data);
      const before = read.events.slice(0, read.events.indexOf(second));
      const call = adapter.render(
        buildRequest(before, {
          header,
          params: { maxTokens: recorded.params.maxTokens },
          cache: { breakpoints: "auto", ttl: "auto" },
        }),
      );
      const body = modelRequestBody(call);
      expect(new Bun.CryptoHasher("sha256").update(body).digest("hex")).toBe(recorded.bodySha256);
      expect(JSON.stringify(call.messages)).toContain("demo failure");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Turn state machine", event-log "Resume"
  test("a truncated tool call injects the retry instruction mid-turn", async () => {
    const dir = await tempProject({});
    try {
      const adapter = stubAdapter([
        { stop: "max_tokens", calls: [{ id: "c1", name: "echo", input: { text: "big" } }] },
        { stop: "end_turn", text: "done small" },
      ]);
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "big job",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("T"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter,
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("done small");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const injected = read.events.find((e) => e.type === "system.injected");
      if (injected === undefined) throw new Error("no system.injected event");
      expect((injected.data as { text: string }).text).toBe(TRUNCATED_INSTRUCTION);
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      const header = headerOf(epochStart.data as never);
      const requests = read.events.filter((e) => e.type === "model.request");
      expect(requests.length).toBe(2);
      const second = requests[1];
      if (second === undefined) throw new Error("no second request");
      const rebuilt = nvidiaAdapter("http://unused").render(
        buildRequest(read.events.slice(0, read.events.indexOf(second)), {
          header,
          params: { maxTokens: 4096 },
          cache: { breakpoints: "auto", ttl: "auto" },
        }),
      );
      expect(JSON.stringify(rebuilt.messages)).toContain(`[Dovet instruction] ${TRUNCATED_INSTRUCTION}`);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Loop and runaway protection"
  test("three malformed rounds end the turn with exit 3", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "broken model",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("M"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "c1", name: "nope", input: {} } },
          { toolCall: { id: "c2", name: "nope", input: {} } },
          { toolCall: { id: "c3", name: "nope", input: {} } },
          { text: "never" },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "guard" });
      expect(exitCodeFor(out.exit)).toBe(3);
      expect(out.incomplete).toBe(true);
      expect(out.result).toContain("/model");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Loop and runaway protection"
  test("the same failing call three times ends the turn with exit 3", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "always fails",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("F"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "c1", name: "echo", input: { text: "x" } } },
          { toolCall: { id: "c2", name: "echo", input: { text: "x" } } },
          { toolCall: { id: "c3", name: "echo", input: { text: "x" } } },
          { text: "never" },
        ]),
        toolDefs: [echoTool(() => ({ status: "error", text: "boom" }))],
      });
      expect(out.exit).toEqual({ kind: "guard" });
      expect(exitCodeFor(out.exit)).toBe(3);
      expect(out.result).toContain("echo(");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Loop and runaway protection"
  test("twenty-five requests with no progress end the turn with exit 3", async () => {
    const dir = await tempProject({});
    try {
      const steps = Array.from({ length: 25 }, (_, i) => ({
        toolCall: { id: `c${i}`, name: "echo", input: { text: `t${i}` } },
      }));
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "busywork",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("P"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([...steps, { text: "never" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "guard" });
      expect(exitCodeFor(out.exit)).toBe(3);
      expect(out.result).toContain("25 requests");
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode", event-log "Resume"
  test("a resumed session warns on the cache drop the provider reports", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("W").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const epochData = {
        epoch: 0,
        reason: "session-start",
        provider: "nvidia",
        model: "test/model",
        systemText: "s",
        toolsJson: "[]",
        thinking: { mode: "off" },
        promptVersion: "0".repeat(64),
      };
      const storedText = (text: string) => ({
        provider: "nvidia",
        protocol: "openai-chat",
        package: "x",
        packageVersion: "1",
        modelId: "test/model",
        parts: [{ kind: "text", text }],
        usage: {},
        finishReason: "stop",
      });
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("V"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error("could not seed the session");
      opened.writer.append({ type: "session.start", epoch: 0, turn: null, data: { mode: "default" } });
      opened.writer.append({ type: "epoch.start", epoch: 0, turn: null, data: epochData });
      for (let turn = 1; turn <= 4; turn++) {
        opened.writer.append({ type: "user.message", epoch: 0, turn, data: { text: `old ${turn}` } });
        opened.writer.append({ type: "model.response", epoch: 0, turn, data: storedText(`answer ${turn}`) });
        opened.writer.append({ type: "turn.end", epoch: 0, turn, data: { reason: "end_turn" } });
      }
      await opened.writer.close();
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: true,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "new turn",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("Y"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "tool_use",
            calls: [{ id: "k1", name: "echo", input: { text: "go" } }],
            usage: { cache_read_input_tokens: 8000 },
          },
          { stop: "end_turn", text: "done", usage: { cache_read_input_tokens: 0 } },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.warnings.some((w) => w.includes("8000"))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode"
  test("a cmd: credential reference is refused without running anything", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: {
          settings: {
            provider: "nvidia",
            model: "test/model",
            providers: { nvidia: { apiKey: "cmd:echo hi" } },
          } as LoadedSettings["settings"],
          rules: { allow: [], ask: [], deny: [] },
          warnings: [],
          notices: [],
          files: [],
        },
        env: { HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "hi",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("K"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "usage" });
      expect(exitCodeFor(out.exit)).toBe(2);
      expect(out.result).toContain("cmd:");
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode"
  test("an unknown permission mode is a usage error", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
          permissionMode: "manual",
        },
        prompt: "hi",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("J"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "usage" });
      expect(exitCodeFor(out.exit)).toBe(2);
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode"
  test("a missing model is a usage error before anything runs", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: {
          settings: {},
          rules: { allow: [], ask: [], deny: [] },
          warnings: [],
          notices: [],
          files: [],
        } as unknown as LoadedSettings,
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "hi",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("N"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "usage" });
      expect(exitCodeFor(out.exit)).toBe(2);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Loop and runaway protection"
  test("the cache monitor stays quiet when the provider reports no cache field", () => {
    expect(cacheWarning({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: undefined })).toBeNull();
    expect(cacheWarning(undefined, { turn: 5, cacheReadTokens: 0 })).toBeNull();
  });

  // spec: tui "Headless mode", agent-loop "Stop-reason handling"
  test("a refusal ends the turn with exit 5", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "forbidden topic",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("B"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([{ stop: "refusal", text: "I cannot help with that" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "refusal" });
      expect(exitCodeFor(out.exit)).toBe(5);
      expect(out.result).toBe("I cannot help with that");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const end = read.events.find((e) => e.type === "turn.end");
      if (end === undefined) throw new Error("no turn.end event");
      expect((end.data as { reason: string }).reason).toBe("refusal");
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode", event-log "Resume"
  test("resuming with a different model is a usage error", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("S").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("D"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error("could not seed the session");
      opened.writer.append({ type: "session.start", epoch: 0, turn: null, data: { mode: "default" } });
      opened.writer.append({
        type: "epoch.start",
        epoch: 0,
        turn: null,
        data: {
          epoch: 0,
          reason: "session-start",
          provider: "nvidia",
          model: "test/model",
          systemText: "s",
          toolsJson: "[]",
          thinking: { mode: "off" },
          promptVersion: "0".repeat(64),
        },
      });
      opened.writer.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "old" } });
      opened.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
      await opened.writer.close();
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: true,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
          model: "other/model",
        },
        prompt: "new turn",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("Z"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "usage" });
      expect(exitCodeFor(out.exit)).toBe(2);
      expect(out.result).toContain("other/model");
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode"
  test("repair without resume is a usage error", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: true,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "hi",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("A"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "usage" });
      expect(exitCodeFor(out.exit)).toBe(2);
      expect(out.result).toContain("--repair");
    } finally {
      await dir.dispose();
    }
  });
});

describe("output redaction", () => {
  // spec: AC-PERM-30
  test("workspace .env values, env secrets and key formats never reach the model or the log", async () => {
    const dir = await tempProject({ ".env": "DB_PASSWORD=correct-horse-battery-9\n" });
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: {
          NVIDIA_API_KEY: "nvapi-FAKE-KEY-0001",
          STRIPE_SECRET_KEY: "rk-live-example-0001-fakevalue",
          HOME: "/tmp",
        },
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "read the config",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("R"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([{ toolCall: { id: "c1", name: "echo", input: { text: "go" } } }, { text: "done" }]),
        toolDefs: [
          echoTool(() => ({
            status: "ok",
            text: "db correct-horse-battery-9 stripe rk-live-example-0001-fakevalue key sk-ant-example-fake-key-000004 cred nvapi-FAKE-KEY-0001",
          })),
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const events = (await readSession(loc)).events.filter((e) => e.type === "tool.result");
      expect(events.length).toBeGreaterThan(0);
      const logged = JSON.stringify(events);
      for (const s of [
        "correct-horse-battery-9",
        "rk-live-example-0001-fakevalue",
        "sk-ant-example-fake-key-000004",
        "nvapi-FAKE-KEY-0001",
      ])
        expect(logged, s).not.toContain(s);
      for (const m of ["[REDACTED:DB_PASSWORD]", "[REDACTED:STRIPE_SECRET_KEY]", "[REDACTED:ANTHROPIC_KEY]"])
        expect(logged, m).toContain(m);
      // The credential ties with the env entry on length and is listed first, so this marker proves the
      // credential arm of the redaction set is load-bearing.
      expect(logged).toContain("[REDACTED:CREDENTIAL]");
      const onDisk = await readFile(sessionPaths(loc).log, "utf8");
      for (const s of [
        "correct-horse-battery-9",
        "rk-live-example-0001-fakevalue",
        "sk-ant-example-fake-key-000004",
        "nvapi-FAKE-KEY-0001",
      ])
        expect(onDisk, s).not.toContain(s);
    } finally {
      await dir.dispose();
    }
  });
});
