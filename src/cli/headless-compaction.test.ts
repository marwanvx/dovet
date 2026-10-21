// Compaction in the headless run (context §6 "Triggers"): auto at the threshold, forced on context_exceeded.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { fakePlatform, sequentialIds, tempProject } from "../../test/helpers/index.ts";
import type { RenderInput } from "../ai/index.ts";
import type { Os } from "../platform/index.ts";
import { CompactionData, EpochStartData } from "../schema/index.ts";
import type { LoadedSettings, LoadInput } from "../store/index.ts";
import { readSession } from "../store/index.ts";
import type { ToolDefinition } from "../tools/index.ts";
import { type HeadlessRunInput, runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 12);
/** Window 10,000, output reserve 4,096, threshold 0.9: compaction above 5,313 tokens. */
const WINDOW = 10_000;

const bigTool = (chars: number): ToolDefinition<unknown> =>
  ({
    name: "dump",
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
    run: () => Promise.resolve({ status: "ok", content: [{ kind: "text", text: "d".repeat(chars) }] }),
  }) as ToolDefinition<unknown>;

type Reply = { stop: "tool_use" | "end_turn" | "context_exceeded"; text?: string; call?: boolean; usage?: object };

/** Replies in order; a request whose last user message holds the compaction prompt is the summary request. */
function scripted(script: Reply[], onSummary: () => void = () => undefined) {
  const requests: { transcript: RenderInput["transcript"]; summary: boolean }[] = [];
  let current: RenderInput | undefined;
  let next = 0;
  const adapter = {
    render: (input: RenderInput) => {
      current = input;
      return { provider: "nvidia", package: "x", modelId: "m", messages: [], tools: [], providerOptions: {} };
    },
    stream: async function* () {
      const transcript = current?.transcript ?? [];
      const last = transcript.at(-1);
      const summary =
        last?.kind === "user" &&
        last.parts.some((p) => p.kind === "text" && p.text.includes("User's requests and constraints"));
      requests.push({ transcript, summary });
      if (summary) onSummary();
      const step: Reply = summary
        ? { stop: "end_turn", text: "SUMMARY OF THE WORK", usage: { promptTokens: 50, completionTokens: 20 } }
        : (script[next++] ?? { stop: "end_turn", text: "extra" });
      yield {
        type: "done",
        stopReason: step.stop,
        stored: {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "x",
          packageVersion: "1",
          modelId: "m",
          parts:
            step.call === true
              ? [{ kind: "tool_call", id: `call${next}`, name: "dump", inputJson: "{}" }]
              : step.text === undefined
                ? []
                : [{ kind: "text", text: step.text }],
          usage: step.usage ?? { promptTokens: 100, completionTokens: 10 },
          finishReason: "stop",
        },
      };
    },
  };
  return { adapter: adapter as never, requests };
}

async function run(over: Partial<HeadlessRunInput>, dir: { root: string }) {
  const env = { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" };
  const settings = {
    settings: { provider: "nvidia", model: "test/model" },
    rules: { allow: [], ask: [], deny: [] },
    warnings: [],
    notices: [],
    files: [],
    untrusted: [],
  } as unknown as LoadedSettings;
  const loadInput: LoadInput = {
    dirs: { config: join(dir.root, "cfg") },
    home: join(dir.root, "home"),
    projectRoot: dir.root,
    env,
    trust: { project: true, local: true },
  };
  const out = await runHeadless({
    dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
    projectRoot: dir.root,
    cwd: dir.root,
    os: testOs(),
    settings,
    env,
    loadInput,
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
    prompt: "build the thing, and never touch /etc",
    clock: { now: () => NOW },
    ids: sequentialIds("C"),
    pid: 1,
    host: "h",
    platform: fakePlatform(),
    contextWindow: WINDOW,
    ...over,
  });
  const log = (
    await readSession({ data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId })
  ).events;
  return { out, log };
}

const project = () => tempProject({ ".dovet/settings.json": JSON.stringify({ checkpoints: { enabled: false } }) });

describe("compaction in a headless run", () => {
  // spec: AC-CTX-11
  test("compacts at the threshold, after the tool round's results and before the next request", async () => {
    const dir = await project();
    try {
      const model = scripted([
        { stop: "tool_use", call: true, usage: { promptTokens: 4000, completionTokens: 1500 } },
        { stop: "end_turn", text: "all done" },
      ]);
      const { out, log } = await run({ adapter: model.adapter, toolDefs: [bigTool(10)] }, dir);
      const types = log.map((e) => e.type);
      const compactionAt = types.indexOf("compaction");
      expect(compactionAt).toBeGreaterThan(types.lastIndexOf("tool.result", compactionAt));
      expect(types.slice(types.indexOf("model.response"), types.indexOf("tool.result"))).not.toContain("compaction");
      expect(types.slice(compactionAt)).toContain("model.request");
      expect(types.slice(0, compactionAt).filter((t) => t === "model.request")).toHaveLength(1);
      const c = CompactionData.parse(log[compactionAt]?.data);
      expect(c).toMatchObject({ from: 0, to: 1, trigger: "auto", kind: "summary" });
      expect(model.requests.map((r) => r.summary)).toEqual([false, true, false]);
      expect(out.result).toBe("all done");
      const final = model.requests[2]?.transcript ?? [];
      expect(final).toHaveLength(1);
      const first = final[0];
      const text = first?.kind === "user" ? first.parts.map((p) => (p.kind === "text" ? p.text : "")).join("") : "";
      expect(text).toContain("build the thing, and never touch /etc");
      expect(text).toContain("SUMMARY OF THE WORK");
      expect(text).toContain("dump");
      expect(out.warnings.some((w) => w.includes("context compacted (auto)"))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  test("stays quiet below the threshold", async () => {
    const dir = await project();
    try {
      const model = scripted([
        { stop: "tool_use", call: true, usage: { promptTokens: 2000, completionTokens: 100 } },
        { stop: "end_turn", text: "fine" },
      ]);
      const { log } = await run({ adapter: model.adapter, toolDefs: [bigTool(10)] }, dir);
      expect(log.some((e) => e.type === "compaction")).toBe(false);
      expect(model.requests.some((r) => r.summary)).toBe(false);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-20
  test("a last response that reported zero usage still triggers compaction on time", async () => {
    const dir = await project();
    try {
      const model = scripted([
        { stop: "tool_use", call: true, usage: {} },
        { stop: "end_turn", text: "fine" },
      ]);
      const { log } = await run({ adapter: model.adapter, toolDefs: [bigTool(30_000)] }, dir);
      expect(log.some((e) => e.type === "compaction")).toBe(true);
      expect(model.requests.map((r) => r.summary)).toEqual([false, true, false]);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-19
  test("the new epoch's system prompt is rendered again, with the date of that moment", async () => {
    const dir = await project();
    try {
      let now = NOW;
      const model = scripted(
        [
          { stop: "tool_use", call: true, usage: { promptTokens: 4000, completionTokens: 1500 } },
          { stop: "end_turn", text: "ok" },
        ],
        () => {
          now += DAY_MS;
        },
      );
      const { log } = await run({ adapter: model.adapter, toolDefs: [bigTool(10)], clock: { now: () => now } }, dir);
      const starts = log.filter((e) => e.type === "epoch.start").map((e) => EpochStartData.parse(e.data));
      expect(starts.map((s) => s.reason)).toEqual(["session-start", "compaction"]);
      expect(starts[0]?.systemText).toContain("2026-10-15");
      expect(starts[1]?.systemText).toContain("2026-10-16");
      expect(starts[1]?.toolsJson).toBe(starts[0]?.toolsJson ?? "");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-20
  test("a context_exceeded response forces a compaction and the request is sent again", async () => {
    const dir = await project();
    try {
      const model = scripted([{ stop: "context_exceeded" }, { stop: "end_turn", text: "after forced" }]);
      const { out, log } = await run({ adapter: model.adapter, toolDefs: [bigTool(10)] }, dir);
      const c = log.find((e) => e.type === "compaction");
      expect(CompactionData.parse(c?.data)).toMatchObject({ trigger: "context-exceeded", kind: "summary" });
      expect(out.result).toBe("after forced");
      expect(model.requests.map((r) => r.summary)).toEqual([false, true, false]);
    } finally {
      await dir.dispose();
    }
  });

  test("a second context_exceeded right after a forced compaction ends the turn instead of looping", async () => {
    const dir = await project();
    try {
      const model = scripted([
        { stop: "context_exceeded" },
        { stop: "context_exceeded" },
        { stop: "context_exceeded" },
      ]);
      const { out } = await run({ adapter: model.adapter, toolDefs: [bigTool(10)] }, dir);
      expect(out.stopReason).toBe("error");
      expect(model.requests.filter((r) => r.summary)).toHaveLength(1);
    } finally {
      await dir.dispose();
    }
  });
});
