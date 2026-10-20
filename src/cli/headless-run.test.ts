// Headless agent turn tests (tui Headless mode, agent-loop Turn state machine, event-log Resume, providers section 1).
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  fakePlatform,
  nvidiaAdapter,
  scriptedModel,
  sequentialIds,
  sseBody,
  startFixtureServer,
  startScriptedServer,
  type TempProject,
  tempProject,
} from "../../test/helpers/index.ts";
import {
  buildRequest,
  cacheWarning,
  ENDED_NOT_RUN,
  headerOf,
  INTERRUPTED_NOT_RUN,
  INTERRUPTED_TOOL_TEXT,
  modelRequestBody,
  REFUSAL_NOT_RUN,
  serializeTools,
  TRUNCATED_INSTRUCTION,
  TRUNCATED_NOT_RUN,
} from "../agent/index.ts";
import { createSdkAdapter, type RenderInput, type SdkCall } from "../ai/index.ts";
import type { Os } from "../platform/index.ts";
import { ModelRequestData, type Part, type StoredResponse } from "../schema/index.ts";
import type { LoadedSettings, LoadInput } from "../store/index.ts";
import { openSession, readSession, sessionPaths } from "../store/index.ts";
import type { ToolDefinition } from "../tools/index.ts";
import { readTool } from "../tools/index.ts";
import { exitCodeFor } from "./headless-output.ts";
import { type HeadlessAdapter, headlessToolDefs, resolveHeadlessModel, runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");

function settingsFor(model = "test/model"): LoadedSettings {
  return {
    settings: { provider: "nvidia", model } as LoadedSettings["settings"],
    rules: { allow: [], ask: [], deny: [] },
    warnings: [],
    notices: [],
    files: [],
    untrusted: [],
  };
}

const TEST_ENV: Record<string, string | undefined> = { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" };

/** The same LoadInput main.ts builds, pointing at the test project, so the turn polls real settings files. */
function loadInputFor(dir: TempProject, env: Record<string, string | undefined>): LoadInput {
  return {
    dirs: { config: join(dir.root, "cfg") },
    home: join(dir.root, "home"),
    projectRoot: dir.root,
    env,
    trust: { project: true, local: true },
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
  reasoning?: string;
  usage?: Record<string, unknown>;
  fail?: string;
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
      if (step.fail !== undefined) {
        yield {
          type: "error",
          error: { kind: "invalid_request", retryable: false, message: step.fail },
          completed: null,
        };
        return;
      }
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
            ...(step.reasoning === undefined ? [] : [{ kind: "reasoning", summary: step.reasoning }]),
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function readTestTool(text: string, onStart: () => void): ToolDefinition<unknown> {
  return {
    name: "Read",
    input: z.strictObject({ file_path: z.string() }),
    descriptionFile: "tools/Read.md",
    errorExample: { file_path: "x" },
    parallelSafe: true,
    mutates: "none",
    describeAction: () => ({
      kind: "read",
      paths: [],
      effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
    }),
    run: () => {
      onStart();
      return Promise.resolve({ status: "ok", content: [{ kind: "text", text }] });
    },
  } as ToolDefinition<unknown>;
}

/** Streams one tool call, then finishes only after the driver started running it (or fails). */
function earlyProbeAdapter(input: {
  call: { id: string; name: string; input: unknown };
  started: Promise<void>;
  firstStop: "tool_use" | "max_tokens";
  thenText: string;
}) {
  let step = 0;
  const response = (parts: unknown[], finishReason: string) => ({
    provider: "nvidia",
    protocol: "openai-chat",
    package: "x",
    packageVersion: "1",
    modelId: "m",
    parts,
    usage: {},
    finishReason,
  });
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
      step += 1;
      if (step === 1) {
        yield { type: "tool_call.start", blockIndex: 0, id: input.call.id, name: input.call.name };
        yield { type: "tool_call.delta", blockIndex: 0, partialJson: JSON.stringify(input.call.input) };
        yield { type: "block.done", blockIndex: 0, kind: "tool_call" };
        const started = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1000);
          void input.started.then(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (!started) throw new Error("the tool was not started while the response was still streaming");
        yield {
          type: "done",
          stopReason: input.firstStop,
          stored: response(
            [
              {
                kind: "tool_call",
                id: input.call.id,
                name: input.call.name,
                inputJson: JSON.stringify(input.call.input),
              },
            ],
            input.firstStop === "tool_use" ? "tool_calls" : "length",
          ),
        };
        return;
      }
      yield {
        type: "done",
        stopReason: "end_turn",
        stored: response([{ kind: "text", text: input.thenText }], "stop"),
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
    const defs = headlessToolDefs({ shell: undefined, tmpDir: "/tmp" });
    const names = defs.map((d) => d.name);
    expect(names).toContain("Read");
    expect(names).toContain("Bash");
    expect(names).not.toContain("PowerShell");
    expect(names).not.toContain("AskUserQuestion");
  });

  // spec: platforms "Windows specifics" (QUESTIONS Q39)
  test("registers the shell the platform resolved, with its matching description", () => {
    const gitBash = headlessToolDefs({ shell: { kind: "git-bash", path: "/git/bash.exe" as never }, tmpDir: "/tmp" });
    expect(gitBash.find((d) => d.name === "Bash")?.descriptionFile).toBe("tools/BashGitBash.md");

    const pwsh = headlessToolDefs({
      shell: { kind: "powershell", path: "/ps/pwsh.exe" as never, edition: "pwsh" },
      tmpDir: "/tmp",
    });
    expect(pwsh.map((d) => d.name)).toContain("PowerShell");
    expect(pwsh.map((d) => d.name)).not.toContain("Bash");
    expect(pwsh.find((d) => d.name === "PowerShell")?.descriptionFile).toBe("tools/PowerShell.md");

    const windows = headlessToolDefs({
      shell: { kind: "powershell", path: "/ps/ps.exe" as never, edition: "windows" },
      tmpDir: "/tmp",
    });
    expect(windows.find((d) => d.name === "PowerShell")?.descriptionFile).toBe("tools/PowerShell51.md");
  });

  // spec: AC-CLI-19
  test("offline filters out WebFetch and WebSearch if present", () => {
    const fakeWebFetch = {
      name: "WebFetch",
      descriptionFile: "tools/Bash.md",
      inputSchema: z.object({}),
      execute: async () => ({ kind: "ok", output: "" }),
    } as unknown as ToolDefinition<unknown>;
    const fakeWebSearch = {
      name: "WebSearch",
      descriptionFile: "tools/Bash.md",
      inputSchema: z.object({}),
      execute: async () => ({ kind: "ok", output: "" }),
    } as unknown as ToolDefinition<unknown>;
    const onlineDefs = headlessToolDefs({
      shell: undefined,
      tmpDir: "/tmp",
      offline: false,
      baseTools: [fakeWebFetch, fakeWebSearch],
    });
    expect(onlineDefs.map((d) => d.name)).toContain("WebFetch");
    expect(onlineDefs.map((d) => d.name)).toContain("WebSearch");

    const offlineDefs = headlessToolDefs({
      shell: undefined,
      tmpDir: "/tmp",
      offline: true,
      baseTools: [fakeWebFetch, fakeWebSearch],
    });
    expect(offlineDefs.map((d) => d.name)).not.toContain("WebFetch");
    expect(offlineDefs.map((d) => d.name)).not.toContain("WebSearch");
  });
});

describe("runHeadless", () => {
  test("a tool-using turn writes the expected event types and fingerprint hash", async () => {
    const dir = await tempProject({ "note.txt": "hello" });
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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

  // spec: tui "Headless mode"
  test("usage and cost add up every request of the turn, not just the last", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "json",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "go",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("Q"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "tool_use",
            calls: [{ id: "c1", name: "echo", input: { text: "a" } }],
            usage: { promptTokens: 1000, completionTokens: 100 },
          },
          {
            stop: "tool_use",
            calls: [{ id: "c2", name: "echo", input: { text: "b" } }],
            usage: { promptTokens: 2000, completionTokens: 200 },
          },
          { stop: "end_turn", text: "done", usage: { promptTokens: 3000, completionTokens: 300 } },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.usage).toEqual({ promptTokens: 6000, completionTokens: 600 });
      expect(out.cost).toBe(0.0156);
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode"
  test("nested usage objects are added field by field", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "json",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "go",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("N"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "tool_use",
            calls: [{ id: "c1", name: "echo", input: { text: "a" } }],
            usage: { inputTokens: { total: 1000, cacheRead: 400 }, outputTokens: { total: 100 } },
          },
          {
            stop: "end_turn",
            text: "done",
            usage: { inputTokens: { total: 2000, cacheRead: 1500 }, outputTokens: { total: 50 } },
          },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.usage).toEqual({
        inputTokens: { total: 3000, cacheRead: 1900 },
        outputTokens: { total: 150 },
      });
      expect(out.cost).toBe(0.0069);
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode"
  test("a turn that fails after a paid request still reports that request's cost", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "json",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "go",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("E"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "tool_use",
            calls: [{ id: "c1", name: "echo", input: { text: "a" } }],
            usage: { promptTokens: 1000, completionTokens: 100 },
          },
          { stop: "end_turn", fail: "the provider refused the request" },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "error" });
      expect(out.usage).toEqual({ promptTokens: 1000, completionTokens: 100 });
      expect(out.cost).toBe(0.0026);
    } finally {
      await dir.dispose();
    }
  });

  // spec: tui "Headless mode"
  test("a turn stopped by the request guard still reports what its requests used and cost", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "json",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          maxRequests: 2,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "go",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("G"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter(
          [1, 2, 3].map((i) => ({
            stop: "tool_use" as const,
            calls: [{ id: `c${i}`, name: "echo", input: { text: `t${i}` } }],
            usage: { promptTokens: 1000, completionTokens: 100 },
          })),
        ),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "guard" });
      expect(out.usage).toEqual({ promptTokens: 2000, completionTokens: 200 });
      expect(out.cost).toBe(0.0052);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-PERM-19
  test("a deny rule written mid-session blocks the next call; removing it unblocks", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": '{ "permissions": { "deny": [] } }' });
    try {
      const local = join(dir.root, ".dovet", "settings.local.json");
      const ran: string[] = [];
      const echo = echoTool((text) => {
        ran.push(text);
        if (text === "add-deny") writeFileSync(local, JSON.stringify({ permissions: { deny: ["echo"] } }));
        return { status: "ok", text: `echo:${text}` };
      });
      const setRules: ToolDefinition<unknown> = {
        name: "SetRules",
        input: z.strictObject({ deny: z.array(z.string()) }),
        descriptionFile: "tools/Read.md",
        errorExample: { deny: [] },
        parallelSafe: true,
        mutates: "none",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: (input) => {
          writeFileSync(local, JSON.stringify({ permissions: { deny: (input as { deny: string[] }).deny } }));
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "rules set" }] });
        },
      };
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "use the tools",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("D"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "c1", name: "echo", input: { text: "add-deny" } } },
          { toolCall: { id: "c2", name: "echo", input: { text: "blocked" } } },
          { toolCall: { id: "c3", name: "SetRules", input: { deny: [] } } },
          { toolCall: { id: "c4", name: "echo", input: { text: "after" } } },
          { text: "done" },
        ]),
        toolDefs: [echo, setRules],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(ran).toEqual(["add-deny", "after"]);
      expect(out.warnings.some((w) => w.includes("Settings updated from") && w.includes("settings.local.json"))).toBe(
        true,
      );
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const changes = read.events.filter((e) => e.type === "settings.change");
      expect(changes.length).toBe(2);
      const added = changes[0]?.data as { old?: { deny?: string[] }; new?: { deny?: string[] } } | undefined;
      expect(added?.old?.deny).toEqual([]);
      expect(added?.new?.deny).toEqual(["echo"]);
      for (const c of changes) {
        expect((c.data as { key: string }).key).toBe("permissions");
        expect((c.data as { source: string }).source).toBe("file");
      }
      const denied = read.events
        .filter((e) => e.type === "tool.result")
        .map((e) => e.data as { status: string; output: string });
      expect(denied.some((d) => d.status === "error" && d.output.includes("Permission denied"))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: cli-config "Live settings reload"
  test("a mid-session edit reaches the next tool call through ctx.settings", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": '{ "permissions": { "deny": [] } }' });
    try {
      const local = join(dir.root, ".dovet", "settings.local.json");
      const seen: unknown[] = [];
      const probe: ToolDefinition<unknown> = {
        name: "Probe",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: true,
        mutates: "none",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: (_input, ctx) => {
          seen.push(ctx.settings);
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "probed" }] });
        },
      };
      const editor = echoTool((text) => {
        if (text === "edit")
          writeFileSync(local, JSON.stringify({ permissions: { deny: [] }, glob: { respectGitignore: false } }));
        return { status: "ok", text: `echo:${text}` };
      });
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "use the tools",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("C"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "c1", name: "Probe", input: {} } },
          { toolCall: { id: "c2", name: "echo", input: { text: "edit" } } },
          { toolCall: { id: "c3", name: "Probe", input: {} } },
          { text: "done" },
        ]),
        toolDefs: [probe, editor],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.warnings.some((w) => w.includes("Settings updated from"))).toBe(true);
      expect(seen).toHaveLength(2);
      const before = seen[0] as { glob?: unknown };
      const after = seen[1] as { glob?: unknown };
      expect(before.glob).toEqual({ respectGitignore: true });
      expect(after.glob).toEqual({ respectGitignore: false });
    } finally {
      await dir.dispose();
    }
  });

  // spec: cli-config "Live settings reload"
  test("a rule written in one batch denies a call in the next batch of the same response", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": '{ "permissions": { "deny": [] } }' });
    try {
      const local = join(dir.root, ".dovet", "settings.local.json");
      const ran: string[] = [];
      const seen: unknown[] = [];
      const echo = echoTool((text) => {
        ran.push(text);
        return { status: "ok", text: `echo:${text}` };
      });
      const setRules: ToolDefinition<unknown> = {
        name: "SetRules",
        input: z.strictObject({ deny: z.array(z.string()) }),
        descriptionFile: "tools/Read.md",
        errorExample: { deny: [] },
        parallelSafe: false,
        mutates: "files",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: (input) => {
          writeFileSync(local, JSON.stringify({ permissions: { deny: (input as { deny: string[] }).deny } }));
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "rules set" }] });
        },
      };
      const probe: ToolDefinition<unknown> = {
        name: "Probe",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: true,
        mutates: "none",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: (_input, ctx) => {
          seen.push(ctx.settings);
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "probed" }] });
        },
      };
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "use the tools",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("0"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          {
            toolCalls: [
              { id: "c1", name: "SetRules", input: { deny: ["echo"] } },
              { id: "c2", name: "echo", input: { text: "blocked" } },
              { id: "c3", name: "Probe", input: {} },
            ],
          },
          { text: "done" },
        ]),
        toolDefs: [echo, setRules, probe],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(ran).toEqual([]);
      // Probe shares batch 2 with the denied echo and must see the settings that batch poll applied.
      expect(seen).toHaveLength(1);
      expect((seen[0] as { permissions?: { deny?: string[] } }).permissions?.deny).toEqual(["echo"]);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const denied = read.events
        .filter((e) => e.type === "tool.result")
        .map((e) => e.data as { status: string; output: string });
      expect(denied).toHaveLength(3);
      expect(denied.filter((d) => d.status === "error" && d.output.includes("Permission denied"))).toHaveLength(1);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-PERM-19
  test("a mid-session model change in the file is announced, not applied", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": '{ "model": "test/model" }' });
    try {
      const local = join(dir.root, ".dovet", "settings.local.json");
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "switch the model",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("M"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([{ toolCall: { id: "c1", name: "echo", input: { text: "rewrite" } } }, { text: "done" }]),
        toolDefs: [
          echoTool((text) => {
            if (text === "rewrite")
              // Different lengths so the rewrite is visible to stat polling even within one mtime tick.
              writeFileSync(local, '{ "model": "model-two" }');
            return { status: "ok", text: `echo:${text}` };
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("done");
      expect(
        out.warnings.some((w) => w.includes("model-two") && w.includes("test/model") && w.includes("Settings file")),
      ).toBe(true);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const changes = read.events.filter((e) => e.type === "settings.change");
      expect(changes).toEqual([]);
      for (const req of read.events.filter((e) => e.type === "model.request"))
        expect((req.data as { model: string }).model).toBe("test/model");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-PERM-19
  test("a mid-session edit that fails the rule compile keeps the previous rules with a warning", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": '{ "permissions": { "deny": ["echo"] } }' });
    try {
      const local = join(dir.root, ".dovet", "settings.local.json");
      const ran: string[] = [];
      const setFile: ToolDefinition<unknown> = {
        name: "SetFile",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: false,
        mutates: "files",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: () => {
          // Schema-valid but rule-compile-breaking; the deny list also drops "echo" on paper, so only
          // keeping the previous rules lets the later echo call be denied again.
          writeFileSync(
            local,
            JSON.stringify({ permissions: { deny: [], examples: [{ Bash: "echo hi", expect: "deny" }] } }),
          );
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "wrote" }] });
        },
      };
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "use the tools",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("K"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "c1", name: "SetFile", input: {} } },
          { toolCall: { id: "c2", name: "echo", input: { text: "still" } } },
          { text: "done" },
        ]),
        toolDefs: [
          echoTool((text) => {
            ran.push(text);
            return { status: "ok", text: `echo:${text}` };
          }),
          setFile,
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(ran).toEqual([]);
      expect(out.warnings.some((w) => w.includes("kept the previous rules"))).toBe(true);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.some((e) => e.type === "settings.change")).toBe(true);
      const results = read.events
        .filter((e) => e.type === "tool.result")
        .map((e) => e.data as { status: string; output: string });
      expect(results.filter((r) => r.status === "error" && r.output.includes("Permission denied"))).toHaveLength(1);
    } finally {
      await dir.dispose();
    }
  });

  // spec: permissions §3.1 (a rule that compiles with a warning surfaces it on reload too)
  test("a rule warning from a mid-session edit reaches the run's warnings", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": "{}" });
    try {
      const local = join(dir.root, ".dovet", "settings.local.json");
      const setFile: ToolDefinition<unknown> = {
        name: "SetFile",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: false,
        mutates: "files",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: () => {
          writeFileSync(local, JSON.stringify({ permissions: { allow: ["Read(open[)"] } }));
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "wrote" }] });
        },
      };
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "use the tools",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("D"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "c1", name: "SetFile", input: {} } },
          { toolCall: { id: "c2", name: "echo", input: { text: "hi" } } },
          { text: "done" },
        ]),
        toolDefs: [echoTool(), setFile],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.warnings.some((w) => w.includes("Read(open["))).toBe(true);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.some((e) => e.type === "settings.change")).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-PERM-19
  test("a mid-session edit that is invalid JSON keeps the previous settings and the turn continues", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": '{ "permissions": { "deny": [] } }' });
    try {
      const local = join(dir.root, ".dovet", "settings.local.json");
      const ran: string[] = [];
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "use the tools",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("1"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "c1", name: "echo", input: { text: "write-bad" } } },
          { toolCall: { id: "c2", name: "echo", input: { text: "after" } } },
          { text: "done" },
        ]),
        toolDefs: [
          echoTool((text) => {
            ran.push(text);
            if (text === "write-bad") writeFileSync(local, "{ invalid json");
            return { status: "ok", text: `echo:${text}` };
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("done");
      expect(ran).toEqual(["write-bad", "after"]);
      expect(out.warnings.some((w) => w.includes("settings.local.json"))).toBe(true);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "settings.change")).toEqual([]);
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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

  // spec: agent-loop "Turn state machine", AC-LOOP-04, event-log "Resume"
  test("a truncated tool call is answered not-run and retried without executing it", async () => {
    const dir = await tempProject({});
    try {
      const adapter = stubAdapter([
        { stop: "max_tokens", calls: [{ id: "c1", name: "echo", input: { text: "big" } }] },
        { stop: "end_turn", text: "done small" },
      ]);
      let runs = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        toolDefs: [
          echoTool(() => {
            runs += 1;
            return { status: "ok", text: "ran" };
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("done small");
      expect(runs).toBe(0);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.some((e) => e.type === "system.injected")).toBe(false);
      const result = read.events.find((e) => e.type === "tool.result");
      if (result === undefined) throw new Error("no tool.result event");
      expect(result.data).toEqual({ callId: "c1", status: "error", output: TRUNCATED_NOT_RUN });
      const users = read.events.filter((e) => e.type === "user.message");
      const last = users[users.length - 1];
      if (last === undefined) throw new Error("no user.message event");
      expect((last.data as { text: string }).text).toBe(TRUNCATED_INSTRUCTION);
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
      const messages = rebuilt.messages as Array<{ role: string; content: unknown }>;
      const body = JSON.stringify(messages.filter((m) => m.role !== "system"));
      expect(body).toContain(TRUNCATED_INSTRUCTION);
      expect(body).toContain(TRUNCATED_NOT_RUN);
      expect(body).not.toContain("[Dovet instruction]");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Stop-reason handling" (empty or thinking-only response)
  test("thinking-only responses are not appended and finalize after one retry", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "think",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("H"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          { stop: "end_turn", reasoning: "thinking about it" },
          { stop: "end_turn", reasoning: "thinking again" },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("The model returned no answer.");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.request")).toHaveLength(2);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(0);
      const end = read.events.find((e) => e.type === "turn.end");
      if (end === undefined) throw new Error("no turn.end event");
      expect((end.data as { reason: string }).reason).toBe("end_turn");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Stop-reason handling" (empty response)
  test("a response with no parts is empty: not appended, retried once", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "say something",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("5"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([{ stop: "end_turn" }, { stop: "end_turn", text: "second try" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("second try");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.request")).toHaveLength(2);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(1);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Stop-reason handling" (max_tokens without a tool call)
  test("a thinking-only response cut off at the output limit finalizes with the truncation note", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "say something",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("B"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([{ stop: "max_tokens", reasoning: "thinking hard" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toContain("truncated at output limit");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.request")).toHaveLength(1);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(0);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Stop-reason handling" (refusal before any visible output)
  test("a thinking-only refusal retries with a clean transcript", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "say something",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("C"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          { stop: "refusal", reasoning: "the filter stopped the reply" },
          { stop: "end_turn", text: "fine" },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("fine");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.request")).toHaveLength(2);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(1);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Stop-reason handling" (refusal before any visible output)
  test("a second thinking-only refusal finalizes as a refusal", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "say something",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("7"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          { stop: "refusal", reasoning: "the filter stopped the first reply" },
          { stop: "refusal", reasoning: "the filter stopped the second reply" },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "refusal" });
      expect(out.stopReason).toBe("refusal");
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.request")).toHaveLength(2);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(0);
      const ends = read.events.filter((e) => e.type === "turn.end");
      const last = ends[ends.length - 1];
      expect(last === undefined ? "" : (last.data as { reason: string }).reason).toBe("refusal");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Stop-reason handling" (every tool_use gets exactly one tool_result)
  test("an end_turn that carries a tool call logs it as not run and stays resumable", async () => {
    const dir = await tempProject({});
    try {
      let ran = 0;
      const first = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "stop now",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("8"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "end_turn",
            text: "I will stop.",
            calls: [{ id: "c1", name: "echo", input: { text: "hi" } }],
          },
        ]),
        toolDefs: [
          echoTool(() => {
            ran += 1;
            return { status: "ok", text: "ran" };
          }),
        ],
      });
      expect(first.exit).toEqual({ kind: "ok" });
      expect(first.result).toBe("I will stop.");
      expect(ran).toBe(0);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: first.sessionId };
      const read = await readSession(loc);
      const callIds = read.events
        .filter((e) => e.type === "tool.call")
        .map((e) => (e.data as { callId: string }).callId);
      const results = read.events
        .filter((e) => e.type === "tool.result")
        .map((e) => e.data as { callId: string; status: string; output: string });
      expect(callIds).toEqual(["c1"]);
      expect(results.map((r) => r.callId)).toEqual(["c1"]);
      expect(results[0]?.status).toBe("error");
      expect(results[0]?.output).toBe(ENDED_NOT_RUN);
      const again = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "again",
        clock: { now: () => Date.UTC(2026, 9, 16) },
        ids: sequentialIds("9"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([{ stop: "end_turn", text: "ok" }]),
        toolDefs: [echoTool()],
      });
      expect(again.sessionId).toBe(first.sessionId);
      expect(again.exit).toEqual({ kind: "ok" });
      expect(again.result).toBe("ok");
    } finally {
      await dir.dispose();
    }
  });

  // spec: permissions §3.1, agent-loop "Turn state machine" (a settings error must fail closed)
  test("a malformed settings rule is a usage error before anything runs", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": '{ "permissions": { "allow": ["Bash(ls) x"] } }' });
    try {
      let ran = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        ids: sequentialIds("2"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          { stop: "tool_use", calls: [{ id: "c1", name: "echo", input: { text: "x" } }] },
          { stop: "end_turn", text: "never" },
        ]),
        toolDefs: [
          echoTool(() => {
            ran += 1;
            return { status: "ok", text: "ran" };
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "usage" });
      expect(exitCodeFor(out.exit)).toBe(2);
      expect(out.result).toContain("settings.local.json");
      expect(ran).toBe(0);
    } finally {
      await dir.dispose();
    }
  });

  // spec: permissions §3.1 (a settings file that loads but fails the rule compile must fail closed)
  test("a failing settings example is a usage error before anything runs", async () => {
    const dir = await tempProject({
      ".dovet/settings.local.json": '{ "permissions": { "examples": [{ "Bash": "echo hi", "expect": "deny" }] } }',
    });
    try {
      let ran = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        ids: sequentialIds("6"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          { stop: "tool_use", calls: [{ id: "c1", name: "echo", input: { text: "x" } }] },
          { stop: "end_turn", text: "never" },
        ]),
        toolDefs: [
          echoTool(() => {
            ran += 1;
            return { status: "ok", text: "ran" };
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "usage" });
      expect(exitCodeFor(out.exit)).toBe(2);
      expect(out.result).toContain("expected deny but is");
      expect(ran).toBe(0);
    } finally {
      await dir.dispose();
    }
  });

  // spec: cli-config "Startup sequence (interactive)" (step 1), permissions §3.1
  test("a broken settings file is a usage error before anything runs", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": "{ not json" });
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        ids: sequentialIds("6"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([{ stop: "end_turn", text: "never" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "usage" });
      expect(exitCodeFor(out.exit)).toBe(2);
      expect(out.result).toContain("settings.local.json");
    } finally {
      await dir.dispose();
    }
  });

  // spec: permissions §3.1 (rule problems that are warnings, not errors, reach the run's warnings)
  test("a rule warning from the settings reaches the run's warnings", async () => {
    const dir = await tempProject({ ".dovet/settings.local.json": '{ "permissions": { "allow": ["Read(open[)"] } }' });
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        ids: sequentialIds("7"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([{ stop: "end_turn", text: "done" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.warnings.some((w) => w.includes("Read(open["))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: platforms "Windows specifics" (QUESTIONS Q39)
  test("a PowerShell-only host registers PowerShell and tells the model", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: "win32",
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        ids: sequentialIds("W"),
        pid: 1,
        host: "h",
        platform: fakePlatform({
          os: "win32",
          resolveShell: () => Promise.resolve({ kind: "powershell", path: "/ps/pwsh.exe" as never, edition: "pwsh" }),
        }),
        adapter: stubAdapter([{ stop: "end_turn", text: "done" }]),
      });
      expect(out.exit).toEqual({ kind: "ok" });
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: "win32" as const, session: out.sessionId };
      const read = await readSession(loc);
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      const data = epochStart.data as { toolsJson: string; systemText: string };
      const names = (JSON.parse(data.toolsJson) as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain("PowerShell");
      expect(names).not.toContain("Bash");
      expect(data.systemText).toContain("Shell tool: PowerShell 7");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TOOLS-06
  test("a session captures the login shell's environment at start and cleans up its process group; shell.snapshot false skips it", async () => {
    const run = async (snapshot: boolean | undefined) => {
      const dir = await tempProject({});
      const spawned: Array<{ argv: string[]; group: string }> = [];
      const killed: string[] = [];
      try {
        const settings = settingsFor();
        if (snapshot !== undefined) settings.settings.shell = { snapshot };
        const out = await runHeadless({
          dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
          projectRoot: dir.root,
          cwd: dir.root,
          os: testOs(),
          settings,
          env: { ...TEST_ENV, SHELL: "/usr/bin/zsh" },
          loadInput: loadInputFor(dir, TEST_ENV),
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
          ids: sequentialIds("W"),
          pid: 1,
          host: "h",
          platform: fakePlatform({
            resolveShell: () => Promise.resolve({ kind: "bash", path: "/bin/bash" as never }),
            spawn: (cmd) => {
              spawned.push({ argv: cmd.argv, group: cmd.group });
              throw new Error("scripted: no shell here");
            },
            killTree: (group) => {
              killed.push(group);
              return Promise.resolve();
            },
          }),
          adapter: stubAdapter([{ stop: "end_turn", text: "done" }]),
        });
        expect(out.exit).toEqual({ kind: "ok" });
        return { spawned, killed, sessionId: out.sessionId };
      } finally {
        await dir.dispose();
      }
    };
    const on = await run(undefined);
    expect(on.spawned).toEqual([
      {
        argv: [process.platform === "win32" ? "/bin/bash" : "/usr/bin/zsh", "-l", "-i", "-c", "env -0"],
        group: `snapshot:${on.sessionId}`,
      },
    ]);
    expect(new Set(on.killed)).toEqual(new Set([`snapshot:${on.sessionId}`]));
    expect((await run(false)).spawned).toEqual([]);
  });

  // spec: AC-TOOLS-25
  test("a run that ends while the login shell is still starting stops it instead of waiting out the timeout", async () => {
    const dir = await tempProject({});
    const ends: Array<() => void> = [];
    const stream = () => new ReadableStream<Uint8Array>({ start: (c) => void ends.push(() => c.close()) });
    let exit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    try {
      const started = Date.now();
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: { ...TEST_ENV, SHELL: "/usr/bin/zsh" },
        loadInput: loadInputFor(dir, TEST_ENV),
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
        ids: sequentialIds("W"),
        pid: 1,
        host: "h",
        platform: fakePlatform({
          resolveShell: () => Promise.resolve({ kind: "bash", path: "/bin/bash" as never }),
          spawn: () => ({ pid: 1, stdout: stream(), stderr: stream(), exited }),
          killTree: () => {
            for (const end of ends.splice(0)) end();
            exit(null);
            return Promise.resolve();
          },
        }),
        adapter: stubAdapter([{ stop: "end_turn", text: "done" }]),
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Early execution of read-only tools" (ADR-21)
  test("a Read whose block completes during streaming starts before the response ends", async () => {
    const dir = await tempProject({});
    try {
      const started = deferred();
      let runs = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: ["Read"],
          disallowedTools: [],
        },
        prompt: "read it",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("A"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: earlyProbeAdapter({
          call: { id: "c1", name: "Read", input: { file_path: "note.txt" } },
          started: started.promise,
          firstStop: "tool_use",
          thenText: "done",
        }),
        toolDefs: [
          readTestTool("EARLY RESULT", () => {
            runs += 1;
            started.resolve();
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("done");
      expect(runs).toBe(1);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const result = read.events.find((e) => e.type === "tool.result");
      if (result === undefined) throw new Error("no tool.result event");
      expect((result.data as { output: string }).output).toBe("EARLY RESULT");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Early execution of read-only tools" (discard on max_tokens + tool call)
  test("early results are discarded when the response is cut off at max_tokens", async () => {
    const dir = await tempProject({});
    try {
      const started = deferred();
      let runs = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: ["Read"],
          disallowedTools: [],
        },
        prompt: "read it",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("S"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: earlyProbeAdapter({
          call: { id: "c1", name: "Read", input: { file_path: "secret.txt" } },
          started: started.promise,
          firstStop: "max_tokens",
          thenText: "done small",
        }),
        toolDefs: [
          readTestTool("EARLY-SECRET", () => {
            runs += 1;
            started.resolve();
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("done small");
      expect(runs).toBe(1);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const result = read.events.find((e) => e.type === "tool.result");
      if (result === undefined) throw new Error("no tool.result event");
      expect((result.data as { output: string }).output).toBe(TRUNCATED_NOT_RUN);
      expect(JSON.stringify(read.events)).not.toContain("EARLY-SECRET");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Early execution of read-only tools" (never start early)
  test("a mutating tool's completed block does not start early", async () => {
    const dir = await tempProject({});
    try {
      let responseEnded = false;
      let startsBeforeResponseEnd = 0;
      let runs = 0;
      const response = (parts: unknown[], finishReason: string) => ({
        provider: "nvidia",
        protocol: "openai-chat",
        package: "x",
        packageVersion: "1",
        modelId: "m",
        parts,
        usage: {},
        finishReason,
      });
      let step = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: ["Write"],
          disallowedTools: [],
        },
        prompt: "write it",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("8"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: {
          render: () => ({
            provider: "nvidia",
            package: "x",
            modelId: "m",
            messages: [{ role: "user", content: "x" }],
            tools: [],
            providerOptions: {},
          }),
          stream: async function* () {
            step += 1;
            if (step === 1) {
              yield { type: "tool_call.start", blockIndex: 0, id: "c1", name: "Write" };
              yield { type: "tool_call.delta", blockIndex: 0, partialJson: JSON.stringify({ file_path: "x" }) };
              yield { type: "block.done", blockIndex: 0, kind: "tool_call" };
              responseEnded = true;
              yield {
                type: "done",
                stopReason: "tool_use",
                stored: response(
                  [
                    {
                      kind: "tool_call",
                      id: "c1",
                      name: "Write",
                      inputJson: JSON.stringify({ file_path: "x" }),
                    },
                  ],
                  "tool_calls",
                ),
              };
              return;
            }
            yield { type: "done", stopReason: "end_turn", stored: response([{ kind: "text", text: "wrote" }], "stop") };
          },
        } as never,
        toolDefs: [
          {
            name: "Write",
            input: z.strictObject({ file_path: z.string() }),
            descriptionFile: "tools/Write.md",
            errorExample: { file_path: "x" },
            parallelSafe: false,
            mutates: "files",
            describeAction: () => ({
              kind: "edit",
              paths: [],
              effects: { writes: "workspace", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
            }),
            run: () => {
              if (!responseEnded) startsBeforeResponseEnd += 1;
              runs += 1;
              return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "wrote" }] });
            },
          } as ToolDefinition<unknown>,
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(startsBeforeResponseEnd).toBe(0);
      expect(runs).toBe(1);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Stop-reason handling" (pairing invariant), event-log "Resume"
  test("resuming an unpaired transcript stops with an InvariantViolation", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("3").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("4"),
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
      opened.writer.append({
        type: "model.response",
        epoch: 0,
        turn: 1,
        data: {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "x",
          packageVersion: "1",
          modelId: "test/model",
          parts: [{ kind: "tool_call", id: "k1", name: "echo", inputJson: "{}" }],
          usage: {},
          finishReason: "tool_calls",
        },
      });
      opened.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
      await opened.writer.close();
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        ids: sequentialIds("P"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([{ stop: "end_turn", text: "never" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "error" });
      expect(exitCodeFor(out.exit)).toBe(1);
      expect(out.result).toContain("InvariantViolation");
      expect(out.result).toContain("pairing");
      expect(out.result).toContain("--repair");
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Tool execution within a turn" step 5b (per-provider request caps)
  test("a Bedrock-sized tool result is replaced by the request-size guard", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: {
          settings: {
            provider: "bedrock",
            model: "test/model",
            providers: { bedrock: { baseUrl: "http://unused", apiKey: "env:BEDROCK_KEY" } },
          } as LoadedSettings["settings"],
          rules: { allow: [], ask: [], deny: [] },
          warnings: [],
          notices: [],
          files: [],
          untrusted: [],
        },
        env: { ...TEST_ENV, BEDROCK_KEY: "fake-key" },
        loadInput: loadInputFor(dir, { ...TEST_ENV, BEDROCK_KEY: "fake-key" }),
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
        prompt: "read big",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("C"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          { stop: "tool_use", calls: [{ id: "c1", name: "echo", input: { text: "big" } }] },
          { stop: "end_turn", text: "done" },
        ]),
        // 15.1 MB of 4-byte characters: past 90% of Bedrock's 16 MB cap, under the 32 MB default.
        toolDefs: [echoTool(() => ({ status: "ok", text: "\u{1F600}".repeat(3_775_000) }))],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const result = read.events.find((e) => e.type === "tool.result");
      if (result === undefined) throw new Error("no tool.result event");
      expect((result.data as { status: string }).status).toBe("error");
      expect((result.data as { output: string }).output).toContain("90%");
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const callIds = read.events
        .filter((e) => e.type === "tool.call")
        .map((e) => (e.data as { callId: string }).callId);
      const results = read.events
        .filter((e) => e.type === "tool.result")
        .map((e) => e.data as { callId: string; status: string; output: string });
      expect(callIds).toEqual(["c1", "c2", "c3"]);
      expect(results.map((r) => r.callId)).toEqual(["c1", "c2", "c3"]);
      expect(results.every((r) => r.status === "error" && r.output.includes("Unknown tool"))).toBe(true);
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
          untrusted: [],
        },
        env: { HOME: "/tmp" },
        loadInput: loadInputFor(dir, { HOME: "/tmp" }),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
          untrusted: [],
        } as unknown as LoadedSettings,
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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

  // spec: agent-loop "Stop-reason handling" (a refusal's tool calls are never run and are recorded not-run)
  test("a refusal carrying a tool call records it not-run and retries cleanly", async () => {
    const dir = await tempProject({});
    try {
      let runs = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: ["echo"],
          disallowedTools: [],
        },
        prompt: "forbidden topic",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("9"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          { stop: "refusal", calls: [{ id: "c1", name: "echo", input: { text: "x" } }] },
          { stop: "end_turn", text: "fine" },
        ]),
        toolDefs: [
          echoTool(() => {
            runs += 1;
            return { status: "ok", text: "ran" };
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toBe("fine");
      expect(runs).toBe(0);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const result = read.events.find((e) => e.type === "tool.result");
      if (result === undefined) throw new Error("no tool.result event");
      expect((result.data as { output: string }).output).toBe(REFUSAL_NOT_RUN);
    } finally {
      await dir.dispose();
    }
  });

  // spec: agent-loop "Stop-reason handling" (a finalized refusal's log keeps every tool_use paired)
  test("a finalized refusal with a tool call writes a paired log", async () => {
    const dir = await tempProject({});
    try {
      let runs = 0;
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: ["echo"],
          disallowedTools: [],
        },
        prompt: "forbidden topic",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("A"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "refusal",
            text: "I cannot help with that",
            calls: [{ id: "c1", name: "echo", input: { text: "x" } }],
          },
        ]),
        toolDefs: [
          echoTool(() => {
            runs += 1;
            return { status: "ok", text: "ran" };
          }),
        ],
      });
      expect(out.exit).toEqual({ kind: "refusal" });
      expect(runs).toBe(0);
      const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
      const read = await readSession(loc);
      const result = read.events.find((e) => e.type === "tool.result");
      if (result === undefined) throw new Error("no tool.result event");
      expect(result.data).toEqual({ callId: "c1", status: "error", output: REFUSAL_NOT_RUN });
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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

  // spec: AC-TUI-05
  test("--budget 0 stops the turn before sending any request, exiting with kind: budget", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          budget: 0,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "hi",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("A"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([{ stop: "end_turn", text: "should not be reached" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "budget" });
      expect(exitCodeFor(out.exit)).toBe(4);
      expect(out.incomplete).toBe(true);
      expect(out.result).toContain("Budget stops");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TUI-05
  test("--budget stops a multi-turn session when accumulated cost exceeds the limit", async () => {
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          budget: 0.0001,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "echo something",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("B"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          { stop: "tool_use", calls: [{ id: "c1", name: "echo", input: { text: "first" } }] },
          { stop: "end_turn", text: "done" },
        ]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "budget" });
      expect(exitCodeFor(out.exit)).toBe(4);
      expect(out.incomplete).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TUI-05
  test("open task list items report incomplete: true and exit ok with incomplete: true", async () => {
    const { createTodoWriteTool } = await import("../tools/index.ts");
    const todoTool = createTodoWriteTool();
    const dir = await tempProject({});
    try {
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "json",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "track items",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("C"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "tool_use",
            calls: [
              {
                id: "t1",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "done task", activeForm: "doing", status: "completed" },
                    { content: "open task", activeForm: "doing", status: "pending" },
                  ],
                },
              },
            ],
          },
          // Model finalizes without finishing the open task
          { stop: "end_turn", text: "I finished the first item." },
          { stop: "end_turn", text: "Stopping now with items left." },
          { stop: "end_turn", text: "Final summary with items remaining." },
        ]),
        toolDefs: [todoTool],
      });
      expect(out.exit).toEqual({ kind: "ok", incomplete: true });
      expect(exitCodeFor(out.exit)).toBe(0);
      expect(out.incomplete).toBe(true);
      expect(out.stopReason).toBe("end_turn");
      expect(out.result).toBe("Final summary with items remaining.");
      const read = await readSession({
        data: join(dir.root, "data"),
        projectRoot: dir.root,
        os: testOs(),
        session: out.sessionId,
      });
      const continuationMessages = read.events.filter(
        (e) =>
          e.type === "user.message" &&
          (e.data as { text?: string } | undefined)?.text?.includes("remaining open tasks"),
      );
      expect(continuationMessages.length).toBe(2);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-19
  test.each(["WebFetch", "WebSearch"] as const)(
    "--offline refuses %s with offlineRefusal message and logs paired error result",
    async (toolName) => {
      const { offlineRefusal } = await import("./startup.ts");
      const dir = await tempProject({});
      try {
        const out = await runHeadless({
          dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
          projectRoot: dir.root,
          cwd: dir.root,
          os: testOs(),
          settings: settingsFor(),
          env: TEST_ENV,
          loadInput: loadInputFor(dir, TEST_ENV),
          args: {
            print: true,
            output: "text",
            offline: true,
            noSessionPersistence: false,
            continued: false,
            repair: false,
            allowedTools: [],
            disallowedTools: [],
          },
          prompt: "fetch docs",
          clock: { now: () => Date.UTC(2026, 9, 15) },
          ids: sequentialIds("D"),
          pid: 1,
          host: "h",
          platform: fakePlatform(),
          adapter: stubAdapter([
            { stop: "tool_use", calls: [{ id: "f1", name: toolName, input: { query: "https://example.com" } }] },
            { stop: "end_turn", text: "offline refusal noted" },
          ]),
          toolDefs: [echoTool()],
        });
        expect(out.exit).toEqual({ kind: "ok" });
        const read = await readSession({
          data: join(dir.root, "data"),
          projectRoot: dir.root,
          os: testOs(),
          session: out.sessionId,
        });
        const toolResult = read.events.find((e) => e.type === "tool.result");
        expect(toolResult).toBeDefined();
        if (!toolResult) throw new Error("tool.result event not found");
        expect((toolResult.data as { output: string }).output).toContain(offlineRefusal(toolName));
      } finally {
        await dir.dispose();
      }
    },
  );
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
        loadInput: loadInputFor(dir, {
          NVIDIA_API_KEY: "nvapi-FAKE-KEY-0001",
          STRIPE_SECRET_KEY: "rk-live-example-0001-fakevalue",
          HOME: "/tmp",
        }),
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

describe("interrupts", () => {
  function inputFor(dir: TempProject, extra: Record<string, unknown>) {
    return {
      dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
      projectRoot: dir.root,
      cwd: dir.root,
      os: testOs(),
      settings: settingsFor(),
      env: TEST_ENV,
      loadInput: loadInputFor(dir, TEST_ENV),
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
      ids: sequentialIds("S"),
      pid: 1,
      host: "h",
      platform: fakePlatform(),
      ...extra,
    } as unknown as Parameters<typeof runHeadless>[0];
  }

  // spec: AC-LOOP-02, AC-LOOP-14 (the tool.call is on disk before the tool runs, so an abnormal exit leaves it for crash recovery)
  test("an abort while a tool runs leaves its tool.call on disk and ends the turn interrupted", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const os = testOs();
      const sessionId = sequentialIds("H").ulid();
      const log = sessionPaths({ data, projectRoot: dir.root, os, session: sessionId }).log;
      const controller = new AbortController();
      let sawCallOnDisk = false;
      let sawAbort = false;
      const started = deferred();
      const slow: ToolDefinition<unknown> = {
        name: "Slow",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: true,
        mutates: "none",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: async (_input, ctx) => {
          started.resolve();
          const deadline = Date.now() + 5_000;
          for (;;) {
            if ((await readFile(log, "utf8").catch(() => "")).includes('"tool.call"')) break;
            if (Date.now() > deadline) throw new Error("the tool started before its tool.call reached the log");
            await Bun.sleep(25);
          }
          sawCallOnDisk = true;
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) resolve();
            else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          sawAbort = true;
          return { status: "interrupted", content: [{ kind: "text", text: INTERRUPTED_TOOL_TEXT }] };
        },
      } as ToolDefinition<unknown>;
      const run = runHeadless(
        inputFor(dir, {
          ids: sequentialIds("H"),
          signal: controller.signal,
          adapter: adapterFor([{ toolCall: { id: "s1", name: "Slow", input: {} } }, { text: "done" }]),
          toolDefs: [slow],
        }),
      );
      await started.promise;
      const deadline = Date.now() + 5_000;
      while (!sawCallOnDisk) {
        if (Date.now() > deadline) throw new Error("the tool never saw its tool.call on disk");
        await Bun.sleep(10);
      }
      controller.abort();
      const out = await run;
      expect(sawAbort).toBe(true);
      expect(out.exit).toEqual({ kind: "signal", signal: "SIGINT" });
      expect(out.stopReason).toBe("interrupted");
      expect(out.result).toBe("");
      expect(out.sessionId).toBe(sessionId);
      const read = await readSession({ data, projectRoot: dir.root, os, session: out.sessionId });
      const types = read.events.map((e) => e.type);
      expect(types.indexOf("tool.call")).toBeGreaterThan(-1);
      expect(types.indexOf("tool.result")).toBeGreaterThan(types.indexOf("tool.call"));
      const results = read.events
        .filter((e) => e.type === "tool.result")
        .map((e) => e.data as { status: string; output: string });
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("interrupted");
      expect(results[0]?.output).toBe(INTERRUPTED_TOOL_TEXT);
      const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
      expect(ends.at(-1)?.reason).toBe("interrupted");
    } finally {
      await dir.dispose();
    }
  }, 30_000);

  // spec: AC-LOOP-02 (an abort during a retry backoff ends the turn cancelled, never as a run error)
  test("an abort during a retry backoff ends the turn cancelled instead of waiting", async () => {
    const dir = await tempProject({});
    try {
      const server = startScriptedServer([
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
          steps: [{ send: JSON.stringify({ error: { message: "Too many requests" } }) }, { wait: 150 }],
        },
      ]);
      try {
        const controller = new AbortController();
        const run = runHeadless(inputFor(dir, { adapter: nvidiaAdapter(server.baseURL), signal: controller.signal }));
        const deadline = Date.now() + 5_000;
        while (server.received.length === 0) {
          if (Date.now() > deadline) throw new Error("the provider was never called");
          await Bun.sleep(10);
        }
        await Bun.sleep(400); // let the 429 land and the 30 s backoff start
        const abortedAt = Date.now();
        controller.abort();
        const out = await run;
        expect(Date.now() - abortedAt).toBeLessThan(5_000);
        expect(out.exit).toEqual({ kind: "signal", signal: "SIGINT" });
        expect(out.stopReason).toBe("interrupted");
        const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
        const read = await readSession(loc);
        const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
        expect(ends.at(-1)?.reason).toBe("cancelled");
        expect(read.events.some((e) => e.type === "system.injected")).toBe(false);
        expect(read.events.some((e) => e.type === "model.response")).toBe(false);
      } finally {
        server.stop();
      }
    } finally {
      await dir.dispose();
    }
  }, 15_000);

  // spec: AC-LOOP-07 (reasoning-only output appends nothing and leaves the turn `interrupted`, never `cancelled`)
  test("an abort after reasoning-only output appends nothing and ends the turn interrupted", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const os = testOs();
      const adapter = {
        render: () => ({
          provider: "nvidia",
          package: "x",
          modelId: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [],
          providerOptions: {},
        }),
        stream: async function* () {
          yield { type: "reasoning.delta", blockIndex: 0, text: "thinking" };
          yield {
            type: "aborted",
            completed: {
              provider: "nvidia",
              protocol: "openai-chat",
              package: "x",
              packageVersion: "1",
              modelId: "m",
              parts: [{ kind: "reasoning" }],
              usage: {},
              finishReason: null,
            },
          };
        },
      } as never;
      const out = await runHeadless(inputFor(dir, { adapter }));
      expect(out.exit).toEqual({ kind: "signal", signal: "SIGINT" });
      expect(out.stopReason).toBe("interrupted");
      const loc = { data, projectRoot: dir.root, os, session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(0);
      expect(read.events.filter((e) => e.type === "system.injected")).toHaveLength(0);
      const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
      expect(ends.at(-1)?.reason).toBe("interrupted");
      // Not `cancelled`: the turn stays in the transcript, so the next request still carries its user message.
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      const nextTurn = [
        ...read.events,
        {
          v: 1,
          id: "n".repeat(26),
          ts: "2026-10-15T00:00:01.000Z",
          session: out.sessionId,
          epoch: 0,
          turn: 2,
          type: "user.message",
          core: true,
          data: { text: "continue" },
        },
      ] as never;
      const built = buildRequest(nextTurn, {
        header: headerOf(epochStart.data as never),
        params: { maxTokens: 4096 },
        cache: { breakpoints: "auto", ttl: "auto" },
      });
      const userTexts = built.transcript.flatMap((t) =>
        t.kind === "user" ? t.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])) : [],
      );
      expect(userTexts).toContain("go");
      expect(userTexts).toContain("continue");
    } finally {
      await dir.dispose();
    }
  }, 15_000);

  // spec: AC-LOOP-07 (a partially streamed text block appends nothing and still leaves the turn `interrupted`)
  test("an abort after a partially streamed text block ends the turn interrupted", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const os = testOs();
      const adapter = {
        render: () => ({
          provider: "nvidia",
          package: "x",
          modelId: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [],
          providerOptions: {},
        }),
        stream: async function* () {
          yield { type: "text.delta", blockIndex: 0, text: "half" };
          yield { type: "aborted", completed: null };
        },
      } as never;
      const out = await runHeadless(inputFor(dir, { adapter }));
      expect(out.exit).toEqual({ kind: "signal", signal: "SIGINT" });
      expect(out.stopReason).toBe("interrupted");
      const loc = { data, projectRoot: dir.root, os, session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(0);
      expect(read.events.filter((e) => e.type === "system.injected")).toHaveLength(0);
      const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
      expect(ends.at(-1)?.reason).toBe("interrupted");
      // Not `cancelled`: the turn stays in the transcript, so the next request still carries its user message.
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      const nextTurn = [
        ...read.events,
        {
          v: 1,
          id: "n".repeat(26),
          ts: "2026-10-15T00:00:01.000Z",
          session: out.sessionId,
          epoch: 0,
          turn: 2,
          type: "user.message",
          core: true,
          data: { text: "continue" },
        },
      ] as never;
      const built = buildRequest(nextTurn, {
        header: headerOf(epochStart.data as never),
        params: { maxTokens: 4096 },
        cache: { breakpoints: "auto", ttl: "auto" },
      });
      const userTexts = built.transcript.flatMap((t) =>
        t.kind === "user" ? t.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])) : [],
      );
      expect(userTexts).toContain("go");
    } finally {
      await dir.dispose();
    }
  }, 15_000);

  // spec: AC-LOOP-07 (a mid-stream abort keeps completed blocks; their tool calls are answered "Not run")
  test("an abort mid-stream keeps completed blocks and answers their tool calls Not-run", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const os = testOs();
      const adapter = {
        render: () => ({
          provider: "nvidia",
          package: "x",
          modelId: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [],
          providerOptions: {},
        }),
        stream: async function* () {
          yield {
            type: "aborted",
            completed: {
              provider: "nvidia",
              protocol: "openai-chat",
              package: "x",
              packageVersion: "1",
              modelId: "m",
              parts: [
                { kind: "text", text: "kept text" },
                { kind: "tool_call", id: "k1", name: "Read", inputJson: JSON.stringify({ file_path: "a.txt" }) },
              ],
              usage: {},
              finishReason: "tool_calls",
            },
          };
        },
      } as never;
      let handle: { shutdown(): Promise<void>; eventTypes(): readonly string[] } | undefined;
      const out = await runHeadless(
        inputFor(dir, {
          adapter,
          onSession: (h: { shutdown(): Promise<void>; eventTypes(): readonly string[] }) => {
            handle = h;
          },
        }),
      );
      expect(out.exit).toEqual({ kind: "signal", signal: "SIGINT" });
      expect(out.stopReason).toBe("interrupted");
      expect(out.result).toBe("");
      const loc = { data, projectRoot: dir.root, os, session: out.sessionId };
      const read = await readSession(loc);
      expect(handle?.eventTypes()).toEqual(read.events.map((e) => e.type));
      const responses = read.events.filter((e) => e.type === "model.response");
      expect(responses).toHaveLength(1);
      const kept = responses[0]?.data as { parts: Array<{ kind: string }> };
      expect(kept.parts.map((p) => p.kind)).toEqual(["text", "tool_call"]);
      expect(read.events.filter((e) => e.type === "tool.call").map((e) => e.data)).toEqual([
        { callId: "k1", name: "Read", raw: { file_path: "a.txt" }, input: { file_path: "a.txt" } },
      ]);
      expect(read.events.filter((e) => e.type === "tool.result").map((e) => e.data)).toEqual([
        { callId: "k1", status: "interrupted", output: INTERRUPTED_NOT_RUN },
      ]);
      expect(read.events.filter((e) => e.type === "system.injected").map((e) => e.data)).toEqual([
        {
          text: "The user interrupted your response. Blocks that finished are kept above; the rest was discarded.",
          reason: "interrupt-note",
          delivery: "reminder-block",
        },
      ]);
      const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
      expect(ends.at(-1)?.reason).toBe("interrupted");
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      // The next request (a resume's new prompt) carries the note logged by the abort.
      const nextTurn = [
        ...read.events,
        {
          v: 1,
          id: "n".repeat(26),
          ts: "2026-10-15T00:00:01.000Z",
          session: out.sessionId,
          epoch: 0,
          turn: 2,
          type: "user.message",
          core: true,
          data: { text: "continue" },
        },
      ] as never;
      const built = buildRequest(nextTurn, {
        header: headerOf(epochStart.data as never),
        params: { maxTokens: 4096 },
        cache: { breakpoints: "auto", ttl: "auto" },
      });
      const call = createSdkAdapter({
        endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
      }).render(built);
      const messages = JSON.stringify(call.messages);
      expect(messages).toContain("kept text");
      expect(messages).toContain(INTERRUPTED_NOT_RUN);
      expect(messages).toContain("The user interrupted your response.");
    } finally {
      await dir.dispose();
    }
  }, 15_000);

  // spec: AC-LOOP-02 (an abort on a follow-up request keeps the turn's finished request-1 work: interrupted, never cancelled)
  test("an abort on a follow-up request keeps the turn interrupted with its work in the transcript", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const os = testOs();
      let step = 0;
      let runs = 0;
      const adapter = {
        render: () => ({
          provider: "nvidia",
          package: "x",
          modelId: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [],
          providerOptions: {},
        }),
        stream: async function* () {
          step += 1;
          if (step === 1) {
            yield { type: "tool_call.start", blockIndex: 0, id: "c1", name: "Step" };
            yield { type: "tool_call.delta", blockIndex: 0, partialJson: "{}" };
            yield { type: "block.done", blockIndex: 0, kind: "tool_call" };
            yield {
              type: "done",
              stopReason: "tool_use",
              stored: {
                provider: "nvidia",
                protocol: "openai-chat",
                package: "x",
                packageVersion: "1",
                modelId: "m",
                parts: [{ kind: "tool_call", id: "c1", name: "Step", inputJson: "{}" }],
                usage: {},
                finishReason: "tool_calls",
              },
            };
            return;
          }
          yield { type: "aborted", completed: null };
        },
      } as never;
      const stepTool: ToolDefinition<unknown> = {
        name: "Step",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: true,
        mutates: "none",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: () => {
          runs += 1;
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "ran" }] });
        },
      } as ToolDefinition<unknown>;
      const out = await runHeadless(inputFor(dir, { adapter, toolDefs: [stepTool] }));
      expect(out.exit).toEqual({ kind: "signal", signal: "SIGINT" });
      expect(out.stopReason).toBe("interrupted");
      expect(runs).toBe(1);
      const loc = { data, projectRoot: dir.root, os, session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(1);
      expect(
        read.events.filter((e) => e.type === "tool.result").map((e) => (e.data as { status: string }).status),
      ).toEqual(["ok"]);
      const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
      expect(ends.at(-1)?.reason).toBe("interrupted");
      // A `cancelled` turn contributes nothing to a replay; this one keeps its first request's work.
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      const nextTurn = [
        ...read.events,
        {
          v: 1,
          id: "n".repeat(26),
          ts: "2026-10-15T00:00:01.000Z",
          session: out.sessionId,
          epoch: 0,
          turn: 2,
          type: "user.message",
          core: true,
          data: { text: "continue" },
        },
      ] as never;
      const built = buildRequest(nextTurn, {
        header: headerOf(epochStart.data as never),
        params: { maxTokens: 4096 },
        cache: { breakpoints: "auto", ttl: "auto" },
      });
      const userTexts = built.transcript.flatMap((t) =>
        t.kind === "user" ? t.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])) : [],
      );
      expect(userTexts).toContain("go");
      const call = createSdkAdapter({
        endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
      }).render(built);
      const toolMessage = (call.messages as Array<{ role: string; content: unknown[] }>).find((m) => m.role === "tool");
      expect(toolMessage?.content[0]).toEqual({
        type: "tool-result",
        toolCallId: "c1",
        toolName: "Step",
        output: { type: "text", value: "ran" },
      });
    } finally {
      await dir.dispose();
    }
  }, 15_000);

  // spec: AC-LOOP-02 (a done-only response is output too: a follow-up abort stays interrupted and keeps the turn's work)
  test("an abort on a follow-up request after a done-only response keeps the turn interrupted", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const os = testOs();
      let step = 0;
      let runs = 0;
      const adapter = {
        render: () => ({
          provider: "nvidia",
          package: "x",
          modelId: "m",
          messages: [{ role: "user", content: "x" }],
          tools: [],
          providerOptions: {},
        }),
        stream: async function* () {
          step += 1;
          if (step === 1) {
            yield {
              type: "done",
              stopReason: "tool_use",
              stored: {
                provider: "nvidia",
                protocol: "openai-chat",
                package: "x",
                packageVersion: "1",
                modelId: "m",
                parts: [{ kind: "tool_call", id: "c1", name: "Step", inputJson: "{}" }],
                usage: {},
                finishReason: "tool_calls",
              },
            };
            return;
          }
          yield { type: "aborted", completed: null };
        },
      } as never;
      const stepTool: ToolDefinition<unknown> = {
        name: "Step",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: true,
        mutates: "none",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: () => {
          runs += 1;
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "ran" }] });
        },
      } as ToolDefinition<unknown>;
      const out = await runHeadless(inputFor(dir, { adapter, toolDefs: [stepTool] }));
      expect(out.exit).toEqual({ kind: "signal", signal: "SIGINT" });
      expect(out.stopReason).toBe("interrupted");
      expect(runs).toBe(1);
      const loc = { data, projectRoot: dir.root, os, session: out.sessionId };
      const read = await readSession(loc);
      expect(read.events.filter((e) => e.type === "model.response")).toHaveLength(1);
      expect(
        read.events.filter((e) => e.type === "tool.result").map((e) => (e.data as { status: string }).status),
      ).toEqual(["ok"]);
      const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
      expect(ends.at(-1)?.reason).toBe("interrupted");
      // A `cancelled` turn contributes nothing to a replay; this one keeps its first request's work.
      const epochStart = read.events.find((e) => e.type === "epoch.start");
      if (epochStart === undefined) throw new Error("no epoch.start event");
      const nextTurn = [
        ...read.events,
        {
          v: 1,
          id: "n".repeat(26),
          ts: "2026-10-15T00:00:01.000Z",
          session: out.sessionId,
          epoch: 0,
          turn: 2,
          type: "user.message",
          core: true,
          data: { text: "continue" },
        },
      ] as never;
      const built = buildRequest(nextTurn, {
        header: headerOf(epochStart.data as never),
        params: { maxTokens: 4096 },
        cache: { breakpoints: "auto", ttl: "auto" },
      });
      const userTexts = built.transcript.flatMap((t) =>
        t.kind === "user" ? t.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])) : [],
      );
      expect(userTexts).toContain("go");
      const call = createSdkAdapter({
        endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
      }).render(built);
      const toolMessage = (call.messages as Array<{ role: string; content: unknown[] }>).find((m) => m.role === "tool");
      expect(toolMessage?.content[0]).toEqual({
        type: "tool-result",
        toolCallId: "c1",
        toolName: "Step",
        output: { type: "text", value: "ran" },
      });
    } finally {
      await dir.dispose();
    }
  }, 15_000);

  // spec: AC-LOG-12
  test("history rejection offers repair epoch, after repair next request succeeds, and log is append-only", async () => {
    const { APICallError } = await import("ai");
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const out1 = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "step 1",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("H01"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([{ text: "step 1 answer", reasoning: "secret reasoning thoughts" }]),
        toolDefs: [echoTool()],
      });
      expect(out1.exit).toEqual({ kind: "ok" });

      const out1b = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "step 2",
        clock: { now: () => Date.UTC(2026, 9, 15, 0, 1) },
        ids: sequentialIds("H02"),
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
      expect(out1b.exit).toEqual({ kind: "history-rejected" });
      expect(exitCodeFor(out1b.exit)).toBe(6);
      expect(out1b.result).toContain("--repair");

      const paths = sessionPaths({ data, projectRoot: dir.root, os: testOs(), session: out1.sessionId });
      const beforeLog = await readFile(paths.log, "utf8");

      let capturedTranscript: unknown[] = [];
      const baseAdapter = adapterFor([{ text: "repaired and answered successfully" }]);
      const repairAdapter = {
        ...baseAdapter,
        render(input: RenderInput) {
          capturedTranscript = input.transcript;
          return baseAdapter.render(input);
        },
      };

      const out2 = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: true,
          repair: true,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "step 3 repaired",
        clock: { now: () => Date.UTC(2026, 9, 15, 0, 2) },
        ids: sequentialIds("H03"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: repairAdapter,
        toolDefs: [echoTool()],
      });
      expect(out2.exit).toEqual({ kind: "ok" });
      expect(out2.result).toContain("repaired and answered successfully");
      expect(capturedTranscript.length).toBeGreaterThanOrEqual(3);
      const user1 = capturedTranscript[0] as { kind: string; parts: Array<{ text?: string }> };
      expect(user1.kind).toBe("user");
      expect(user1.parts[0]?.text).toBe("step 1");
      const asst = capturedTranscript[1] as { kind: string; stored: StoredResponse };
      expect(asst.kind).toBe("assistant");
      expect(asst.stored.parts.some((p: Part) => p.kind === "reasoning")).toBe(false);
      expect(asst.stored.parts.some((p: Part) => p.kind === "text" && p.text === "step 1 answer")).toBe(true);
      const userLast = capturedTranscript.at(-1) as { kind: string; parts: Array<{ text?: string }> };
      expect(userLast.kind).toBe("user");
      expect(userLast.parts[0]?.text).toBe("step 3 repaired");

      const afterLog = await readFile(paths.log, "utf8");
      expect(afterLog.startsWith(beforeLog)).toBe(true);
      const appended = afterLog.slice(beforeLog.length);
      expect(appended).toContain('"repair"');
      expect(appended).toContain('"repaired and answered successfully"');
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-09
  test("headless turn with --effort high passes reasoning_effort to NVIDIA provider", async () => {
    const delta = (d: unknown, finish: string | null = null) => ({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "meta/llama-3.1-70b-instruct",
      choices: [{ index: 0, delta: d, finish_reason: finish }],
    });
    const server = startFixtureServer([
      {
        request: { path: "", body: "" },
        response: {
          status: 200,
          contentType: "text/event-stream",
          body: sseBody([delta({ content: "ok" }), delta({}, "stop")]),
        },
      },
    ]);
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: {
          ...settingsFor(),
          settings: {
            provider: "nvidia",
            model: "meta/llama-3.1-70b-instruct",
            providers: { nvidia: { baseUrl: server.baseURL } },
          } as LoadedSettings["settings"],
        },
        env: { ...TEST_ENV, NVIDIA_API_KEY: "nvapi-test-key" },
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          effort: "high",
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "test effort",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("EFF"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        toolDefs: [],
      });
      expect(server.received.length).toBeGreaterThan(0);
      const parsedBody = JSON.parse(server.received[0] ?? "{}") as Record<string, unknown>;
      expect(parsedBody.reasoning_effort).toBe("high");
    } finally {
      await server.stop();
      await dir.dispose();
    }
  });

  // spec: AC-TUI-05
  test("headless mode denies tools that ask without prompting and logs status denied", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      let ranInteractiveTool = false;
      const interactiveTool: ToolDefinition<unknown> = {
        name: "InteractivePrompt",
        input: z.object({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: true,
        mutates: "none",
        describeAction: () => ({
          kind: "interaction",
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: () => {
          ranInteractiveTool = true;
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "ran" }] });
        },
      };
      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "run interactive tool",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("ASK"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([
          { toolCall: { id: "call_ask", name: "InteractivePrompt", input: {} } },
          { text: "The interactive tool was denied as expected in headless mode." },
        ]),
        toolDefs: [interactiveTool],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.result).toContain("denied as expected");
      expect(ranInteractiveTool).toBe(false);

      const read = await readSession({ data, projectRoot: dir.root, os: testOs(), session: out.sessionId });
      const toolResult = read.events.find(
        (e) => e.type === "tool.result" && (e.data as { callId?: string }).callId === "call_ask",
      );
      expect(toolResult).toBeDefined();
      const resultData = toolResult?.data as { status: string; output: string };
      expect(["error", "denied"]).toContain(resultData.status);
      expect(resultData.output).toContain("Permission denied");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-LOG-15
  test("resuming with narrower allowedTools still renders stored tool definitions byte-identically", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("T").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const storedToolDefs = [
        { name: "read", description: "read file", inputSchema: { type: "object" } },
        { name: "write", description: "write file", inputSchema: { type: "object" } },
      ];
      const toolsJson = serializeTools(storedToolDefs);
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("T1"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error("could not seed session");
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
          systemText: "sys",
          toolsJson,
          thinking: { mode: "off" },
          promptVersion: "0".repeat(64),
        },
      });
      opened.writer.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "first turn" } });
      opened.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
      await opened.writer.close();

      let capturedCall: SdkCall | undefined;
      const baseAdapter = createSdkAdapter({
        endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
        model: () => scriptedModel([{ text: "done" }]),
      });
      const adapter: HeadlessAdapter = {
        render: (input) => {
          capturedCall = baseAdapter.render(input);
          return capturedCall;
        },
        stream: baseAdapter.stream,
      };

      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: true,
          repair: false,
          allowedTools: ["read"],
          disallowedTools: [],
        },
        prompt: "second turn",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("T2"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter,
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(capturedCall).toBeDefined();
      const renderedTools = capturedCall?.tools as Array<{ name: string; description: string }>;
      expect(renderedTools.map((t) => t.name).sort()).toEqual(["read", "write"]);
      expect(out.warnings.some((w) => w.includes("settings differ from session"))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-LOG-16
  test("damaged log returns read-only error with fork offer; --fork continues from last valid turn", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("D").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("D1"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error("could not seed session");
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
          systemText: "sys",
          toolsJson: "[]",
          thinking: { mode: "off" },
          promptVersion: "0".repeat(64),
        },
      });
      for (let t = 1; t <= 3; t++) {
        opened.writer.append({ type: "user.message", epoch: 0, turn: t, data: { text: `turn ${t}` } });
        opened.writer.append({ type: "turn.end", epoch: 0, turn: t, data: { reason: "end_turn" } });
      }
      await opened.writer.close();

      const paths = sessionPaths(loc);
      const originalLines = (await readFile(paths.log, "utf8")).split("\n");
      const turn3Idx = originalLines.findIndex((l) => l.includes("turn 3"));
      originalLines[turn3Idx] = "not valid json";
      const damagedContent = originalLines.join("\n");
      await writeFile(paths.log, damagedContent);

      const out1 = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "attempt 1",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("D2"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        toolDefs: [echoTool()],
      });
      expect(out1.exit).toEqual({ kind: "error" });
      expect(out1.result).toContain("is read-only");
      expect(out1.result).toContain("--fork (from turn 2)");
      expect(await readFile(paths.log, "utf8")).toBe(damagedContent);

      const out2 = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: true,
          repair: false,
          fork: true,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "forked turn",
        clock: { now: () => Date.UTC(2026, 9, 15, 0, 1) },
        ids: sequentialIds("D3"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([{ text: "forked turn answer" }]),
        toolDefs: [echoTool()],
      });
      expect(out2.exit).toEqual({ kind: "ok" });
      expect(out2.sessionId).not.toBe(session);
      expect(await readFile(paths.log, "utf8")).toBe(damagedContent);

      const forkedRead = await readSession({ data, projectRoot: dir.root, os: testOs(), session: out2.sessionId });
      expect(forkedRead.events.some((e) => e.type === "session.fork")).toBe(true);
      expect(forkedRead.events.filter((e) => e.type === "turn.end")).toHaveLength(3);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-LOG-15
  test("resuming a session restores mode, taint and costUsd into the active turn", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("P").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("P1"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error("could not seed session");
      opened.writer.append({ type: "session.start", epoch: 0, turn: null, data: { mode: "plan" } });
      opened.writer.append({
        type: "epoch.start",
        epoch: 0,
        turn: null,
        data: {
          epoch: 0,
          reason: "session-start",
          provider: "nvidia",
          model: "test/model",
          systemText: "sys",
          toolsJson: "[]",
          thinking: { mode: "off" },
          promptVersion: "0".repeat(64),
        },
      });
      opened.writer.append({
        type: "taint.change",
        epoch: 0,
        turn: 1,
        data: { source: "src/tainted.ts", tainted: true },
      });
      opened.writer.append({ type: "receipt", epoch: 0, turn: 1, data: { turn: 1, cost: { sessionUsd: 1.25 } } });
      opened.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
      await opened.writer.close();

      let observedMode: string | undefined;
      let observedTaint: string[] | undefined;
      const inspectTool: ToolDefinition<unknown> = {
        name: "inspect",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: true,
        mutates: "none",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: (_input, ctx) => {
          observedMode = ctx.session.mode;
          observedTaint = [...ctx.session.taint];
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "inspected" }] });
        },
      };

      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: true,
          repair: false,
          budget: 1.5,
          allowedTools: [],
          disallowedTools: [],
        },
        prompt: "check state",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("P2"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "tool_use",
            calls: [{ id: "c1", name: "inspect", input: {} }],
            usage: { promptTokens: 100_000, completionTokens: 50_000 },
          },
          { stop: "end_turn", text: "done" },
        ]),
        toolDefs: [inspectTool],
      });

      expect(observedMode).toBe("plan");
      expect(observedTaint).toEqual(["src/tainted.ts"]);
      expect(out.exit).toEqual({ kind: "budget" });
      expect(out.cost).toBeGreaterThanOrEqual(1.5);
    } finally {
      await dir.dispose();
    }
  });

  // spec: event-log "Resume"
  test("resuming with differing config model defaults to stored model with a warning", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("M").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("M1"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error("could not seed session");
      opened.writer.append({ type: "session.start", epoch: 0, turn: null, data: { mode: "default" } });
      opened.writer.append({
        type: "epoch.start",
        epoch: 0,
        turn: null,
        data: {
          epoch: 0,
          reason: "session-start",
          provider: "nvidia",
          model: "session/model-v1",
          systemText: "sys",
          toolsJson: "[]",
          thinking: { mode: "off" },
          promptVersion: "0".repeat(64),
        },
      });
      opened.writer.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "hello" } });
      opened.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
      await opened.writer.close();

      let renderedModel: string | undefined;
      const baseAdapter = createSdkAdapter({
        endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
        model: () => scriptedModel([{ text: "resumed ok" }]),
      });
      const adapter: HeadlessAdapter = {
        render: (input) => {
          renderedModel = input.header.model;
          return baseAdapter.render(input);
        },
        stream: baseAdapter.stream,
      };

      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor("new/config-model-v2"),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "resumed turn",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("M2"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter,
        toolDefs: [echoTool()],
      });

      expect(out.exit).toEqual({ kind: "ok" });
      expect(renderedModel).toBe("session/model-v1");
      expect(out.warnings.some((w) => w.includes("session/model-v1") && w.includes("new/config-model-v2"))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: event-log "Resume"
  test("resuming with differing provider exits with usage error naming both and session id", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("PM").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("PM1"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error("could not seed session");
      opened.writer.append({ type: "session.start", epoch: 0, turn: null, data: { mode: "default" } });
      opened.writer.append({
        type: "epoch.start",
        epoch: 0,
        turn: null,
        data: {
          epoch: 0,
          reason: "session-start",
          provider: "other-provider",
          model: "other/model",
          systemText: "sys",
          toolsJson: "[]",
          thinking: { mode: "off" },
          promptVersion: "0".repeat(64),
        },
      });
      opened.writer.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "hello" } });
      opened.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
      await opened.writer.close();

      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        prompt: "resumed turn",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("PM2"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        toolDefs: [echoTool()],
      });

      expect(out.exit).toEqual({ kind: "usage" });
      expect(out.result).toContain('provider "nvidia" does not match session');
      expect(out.result).toContain("other-provider");
      expect(out.result).toContain(session);
    } finally {
      await dir.dispose();
    }
  });

  // spec: event-log "Resume"
  test("cold large session emits cost estimate warning and offers /compact", async () => {
    const dir = await tempProject({});
    try {
      const data = join(dir.root, "data");
      const session = sequentialIds("C").ulid();
      const loc = { data, projectRoot: dir.root, os: testOs(), session };
      const opened = await openSession({
        ...loc,
        clock: { now: () => Date.UTC(2026, 9, 14) },
        ids: sequentialIds("C1"),
        pid: 1,
        host: "h",
        secrets: [],
      });
      if (opened.mode !== "write") throw new Error("could not seed session");
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
          systemText: "s".repeat(20_000),
          toolsJson: JSON.stringify([{ name: "echo", description: "d".repeat(20_000), inputSchema: {} }]),
          thinking: { mode: "off" },
          promptVersion: "0".repeat(64),
        },
      });
      opened.writer.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "msg".repeat(10_000) } });
      opened.writer.append({ type: "turn.end", epoch: 0, turn: 1, data: { reason: "end_turn" } });
      await opened.writer.close();

      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
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
        ids: sequentialIds("C2"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: adapterFor([{ text: "cold large ok" }]),
        toolDefs: [echoTool()],
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(out.warnings.some((w) => w.includes("cold large session") && w.includes("/compact"))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-PERM-26
  test("tool result with hidden characters taints the session, emits taint.change and enforces taint in decide", async () => {
    const dir = await tempProject();
    try {
      const data = join(dir.root, "data");
      const hiddenTool: ToolDefinition<unknown> = {
        name: "untrustedRead",
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
        run: () =>
          Promise.resolve({
            status: "ok",
            content: [{ kind: "text", text: "injection\u{E0041}\u{E0042}payload" }],
          }),
      };

      let observedTaint: string[] | undefined;
      const inspectTool: ToolDefinition<unknown> = {
        name: "inspectTaint",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: false,
        mutates: "none",
        describeAction: () => ({
          kind: "read",
          paths: [],
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
        }),
        run: (_input, ctx) => {
          observedTaint = [...ctx.session.taint];
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "inspected" }] });
        },
      };

      let ranPush = false;
      const pushTool: ToolDefinition<unknown> = {
        name: "gitPush",
        input: z.strictObject({}),
        descriptionFile: "tools/Read.md",
        errorExample: {},
        parallelSafe: false,
        mutates: "none",
        describeAction: () => ({
          kind: "shell",
          shell: "bash",
          command: "git push origin main",
          sandboxed: false,
          unsandboxedRetry: false,
          effects: { writes: "none", network: "none", sensitiveReads: [], remote: ["push"], sandboxed: false },
        }),
        run: () => {
          ranPush = true;
          return Promise.resolve({ status: "ok", content: [{ kind: "text", text: "pushed" }] });
        },
      };

      const out = await runHeadless({
        dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
        projectRoot: dir.root,
        cwd: dir.root,
        os: testOs(),
        settings: settingsFor(),
        env: TEST_ENV,
        loadInput: loadInputFor(dir, TEST_ENV),
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          allowedTools: ["untrustedRead", "inspectTaint"],
          disallowedTools: [],
        },
        prompt: "run untrusted tool",
        clock: { now: () => Date.UTC(2026, 9, 15) },
        ids: sequentialIds("T1"),
        pid: 1,
        host: "h",
        platform: fakePlatform(),
        adapter: stubAdapter([
          {
            stop: "tool_use",
            text: "calling untrusted and inspect",
            calls: [
              { id: "call_1", name: "untrustedRead", input: { text: "x" } },
              { id: "call_2", name: "inspectTaint", input: {} },
            ],
          },
          {
            stop: "tool_use",
            text: "calling push",
            calls: [{ id: "call_3", name: "gitPush", input: {} }],
          },
          { stop: "end_turn", text: "all done" },
        ]),
        toolDefs: [hiddenTool, inspectTool, pushTool],
      });

      expect(out.exit).toEqual({ kind: "ok" });
      expect(observedTaint).toEqual(["untrustedRead result"]);
      expect(ranPush).toBe(false);

      const read = await readSession({ data, projectRoot: dir.root, os: testOs(), session: out.sessionId });
      const taintEvent = read.events.find((e) => e.type === "taint.change");
      expect(taintEvent).toBeDefined();
      const taintData = taintEvent?.data as { source: string; tainted: boolean } | undefined;
      expect(taintData?.source).toBe("untrustedRead result");
      expect(taintData?.tainted).toBe(true);
      const pushResult = read.events.find(
        (e) => e.type === "tool.result" && (e.data as { callId?: string }).callId === "call_3",
      );
      expect(pushResult).toBeDefined();
      const pushData = pushResult?.data as { output: string } | undefined;
      expect(pushData?.output).toBe("Permission denied: remote action: git push");
    } finally {
      await dir.dispose();
    }
  });
});
