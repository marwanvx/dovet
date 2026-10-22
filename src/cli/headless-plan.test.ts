// Plan mode and the plan file in the headless run (tools §11.1, permissions §2; QUESTIONS Q85).
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fakePlatform, sequentialIds, tempProject } from "../../test/helpers/index.ts";
import type { RenderInput } from "../ai/index.ts";
import type { Os } from "../platform/index.ts";
import { CompactionData, type EventEnvelope, SystemInjectedData, ToolResultData } from "../schema/index.ts";
import type { LoadedSettings, LoadInput } from "../store/index.ts";
import { forkAtTurn, PLAN_FILE_KEY, planDir, readSession } from "../store/index.ts";
import { builtinTools, type ToolDefinition } from "../tools/index.ts";
import { type HeadlessRunInput, runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
const NOW = Date.UTC(2026, 9, 15, 12);
const WINDOW = 10_000;
const tools: ToolDefinition<unknown>[] = builtinTools.filter((t) =>
  ["Read", "Write", "EnterPlanMode", "ExitPlanMode"].includes(t.name),
);

type Reply = { calls?: { name: string; input: unknown }[]; text?: string; usage?: object };

function scripted(script: Reply[]) {
  const requests: { transcript: RenderInput["transcript"]; systemText: string; summary: boolean }[] = [];
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
      requests.push({ transcript, systemText: current?.header.systemText ?? "", summary });
      const step: Reply = summary ? { text: "SUMMARY OF THE WORK" } : (script[next++] ?? { text: "extra" });
      const calls = step.calls ?? [];
      yield {
        type: "done",
        stopReason: calls.length > 0 ? "tool_use" : "end_turn",
        stored: {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "x",
          packageVersion: "1",
          modelId: "m",
          parts: [
            ...calls.map((c, i) => ({
              kind: "tool_call" as const,
              id: `call${next}-${i}`,
              name: c.name,
              inputJson: JSON.stringify(c.input),
            })),
            ...(step.text === undefined ? [] : [{ kind: "text" as const, text: step.text }]),
          ],
          usage: step.usage ?? { promptTokens: 100, completionTokens: 10 },
          finishReason: "stop",
        },
      };
    },
  };
  return { adapter: adapter as never, requests };
}

async function run(
  over: Partial<HeadlessRunInput> & { continued?: boolean; mode?: string; resume?: string },
  dir: { root: string },
) {
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
  const { continued = false, mode, resume, ...rest } = over;
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
      continued,
      repair: false,
      allowedTools: [],
      disallowedTools: [],
      ...(mode === undefined ? {} : { permissionMode: mode }),
      ...(resume === undefined ? {} : { resume }),
    },
    prompt: "plan the parser rewrite please",
    clock: { now: () => NOW },
    ids: sequentialIds("C"),
    pid: 1,
    host: "h",
    platform: fakePlatform(),
    contextWindow: WINDOW,
    toolDefs: tools,
    ...rest,
  });
  const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
  return { out, loc, log: (await readSession(loc)).events };
}

const project = () => tempProject({ ".dovet/settings.json": JSON.stringify({ checkpoints: { enabled: false } }) });
const planFileIn = (log: readonly EventEnvelope[]): string | undefined =>
  (
    log.findLast((e) => e.type === "settings.change" && (e.data as { key: string }).key === PLAN_FILE_KEY)?.data as
      | { new: string }
      | undefined
  )?.new;
const results = (log: readonly EventEnvelope[]) =>
  log.filter((e) => e.type === "tool.result").map((e) => ToolResultData.parse(e.data));
const injected = (log: readonly EventEnvelope[]) =>
  log.filter((e) => e.type === "system.injected").map((e) => SystemInjectedData.parse(e.data));
const modeChanges = (log: readonly EventEnvelope[]) =>
  log
    .filter((e) => e.type === "settings.change" && (e.data as { key: string }).key === "mode")
    .map((e) => e.data as { old: string; new: string });

describe("plan mode in a headless run", () => {
  // spec: tools §11.1
  test("a session that starts in plan mode gets a plan file of its own, named in the prompt and in the log; only that file is writable", async () => {
    const dir = await project();
    try {
      const other = join(dir.root, "other.txt");
      const model = scripted([
        { calls: [{ name: "Write", input: { file_path: other, content: "x" } }] },
        { text: "planned" },
      ]);
      const { out, loc, log } = await run({ adapter: model.adapter, mode: "plan" }, dir);
      const plan = planFileIn(log);
      expect(plan).toStartWith(planDir(loc));
      expect(plan).toMatch(/plan-the-parser-rewrite-please-[0-9a-z]{4}\.md$/);
      expect(model.requests[0]?.systemText).toContain(plan ?? "unreachable");
      expect(out.result).toBe("planned");
      const [denied] = results(log);
      expect(denied?.status).not.toBe("ok");
      await expect(readFile(other, "utf8")).rejects.toThrow();
    } finally {
      await dir.dispose();
    }
  });

  // spec: tools §11.1
  test("the model can write the plan file in plan mode", async () => {
    const dir = await project();
    try {
      const first = scripted([{ text: "ok" }]);
      const { log } = await run({ adapter: first.adapter, mode: "plan" }, dir);
      const plan = planFileIn(log) ?? "";
      const model = scripted([
        { calls: [{ name: "Write", input: { file_path: plan, content: "1. read\n2. change\n" } }] },
        { text: "written" },
      ]);
      const again = await run(
        { adapter: model.adapter, continued: true, prompt: "write it", ids: sequentialIds("D") },
        dir,
      );
      expect(results(again.log).at(-1)?.status).toBe("ok");
      expect(await readFile(plan, "utf8")).toBe("1. read\n2. change\n");
    } finally {
      await dir.dispose();
    }
  });

  // spec: tools §11.1
  test("a resumed session is still in plan mode with the same plan file and the stored system prompt", async () => {
    const dir = await project();
    try {
      const first = scripted([{ text: "first" }]);
      const a = await run({ adapter: first.adapter, mode: "plan" }, dir);
      const plan = planFileIn(a.log) ?? "";
      const other = join(dir.root, "other.txt");
      const model = scripted([
        { calls: [{ name: "Write", input: { file_path: other, content: "x" } }] },
        { text: "second" },
      ]);
      const b = await run({ adapter: model.adapter, continued: true, prompt: "go on", ids: sequentialIds("D") }, dir);
      expect(model.requests[0]?.systemText).toBe(first.requests[0]?.systemText ?? "unreachable");
      expect(model.requests[0]?.systemText).toContain(plan);
      expect(results(b.log).at(-1)?.status).not.toBe("ok");
      await expect(readFile(other, "utf8")).rejects.toThrow();
      expect(
        b.log.filter((e) => e.type === "settings.change" && (e.data as { key: string }).key === PLAN_FILE_KEY),
      ).toHaveLength(1);
      expect(modeChanges(b.log)).toEqual([]);
    } finally {
      await dir.dispose();
    }
  });

  // spec: tools §11.2
  test("EnterPlanMode switches the run to plan mode: a plan file, the mode text for the model, and edits refused from then on", async () => {
    const dir = await project();
    try {
      const other = join(dir.root, "other.txt");
      const model = scripted([
        { calls: [{ name: "EnterPlanMode", input: {} }] },
        { calls: [{ name: "Write", input: { file_path: other, content: "x" } }] },
        { text: "done" },
      ]);
      const { loc, log } = await run({ adapter: model.adapter }, dir);
      const plan = planFileIn(log);
      expect(plan).toStartWith(planDir(loc));
      expect(modeChanges(log)).toEqual([expect.objectContaining({ old: "default", new: "plan" })]);
      const note = injected(log).find((i) => i.reason === "mode-change");
      expect(note?.text).toContain("Permission mode: plan");
      expect(note?.text).toContain(plan ?? "unreachable");
      const second = model.requests[1]?.transcript.at(-1);
      expect(JSON.stringify(second)).toContain("Permission mode: plan");
      expect(results(log).at(-1)?.status).not.toBe("ok");
      await expect(readFile(other, "utf8")).rejects.toThrow();
      const next = scripted([{ text: "later" }]);
      const again = await run({ adapter: next.adapter, continued: true, prompt: "more", ids: sequentialIds("D") }, dir);
      expect(planFileIn(again.log)).toBe(plan);
      expect(again.log.filter((e) => e.type === "settings.change").length).toBe(
        log.filter((e) => e.type === "settings.change").length,
      );
    } finally {
      await dir.dispose();
    }
  });

  // spec: permissions §2
  test("leaving plan mode on a resume is logged, told to the model with the approval, and keeps the plan file", async () => {
    const dir = await project();
    try {
      const first = scripted([{ text: "first" }]);
      const a = await run({ adapter: first.adapter, mode: "plan" }, dir);
      const plan = planFileIn(a.log) ?? "";
      const model = scripted([{ text: "implementing" }]);
      const b = await run(
        { adapter: model.adapter, continued: true, mode: "acceptEdits", prompt: "go", ids: sequentialIds("D") },
        dir,
      );
      expect(modeChanges(b.log)).toEqual([expect.objectContaining({ old: "plan", new: "acceptEdits" })]);
      const texts = injected(b.log).map((i) => `${i.reason}: ${i.text}`);
      expect(texts.some((t) => t.startsWith("mode-change: Permission mode: accept edits."))).toBe(true);
      expect(texts).toContain("plan-approved: The user approved the plan. Implement it now.");
      expect(JSON.stringify(model.requests[0]?.transcript)).toContain("The user approved the plan");
      const c = await run(
        { adapter: scripted([{ text: "again" }]).adapter, continued: true, prompt: "more", ids: sequentialIds("E") },
        dir,
      );
      expect(modeChanges(c.log)).toHaveLength(1);
      expect(planFileIn(c.log)).toBe(plan);
    } finally {
      await dir.dispose();
    }
  });
});

describe("the plan file across compaction", () => {
  const big = { promptTokens: 4000, completionTokens: 1500 };

  // spec: tools §11.1
  test("a compaction in plan mode puts the plan file and its text in the new epoch's first message", async () => {
    const dir = await project();
    try {
      const a = await run({ adapter: scripted([{ text: "first" }]).adapter, mode: "plan" }, dir);
      const plan = planFileIn(a.log) ?? "";
      await mkdir(dirname(plan), { recursive: true });
      await writeFile(plan, "PLAN BODY: change the lexer first");
      const model = scripted([
        { calls: [{ name: "Read", input: { file_path: join(dir.root, ".dovet", "settings.json") } }], usage: big },
        { text: "after" },
      ]);
      const b = await run({ adapter: model.adapter, continued: true, prompt: "go on", ids: sequentialIds("D") }, dir);
      const compaction = CompactionData.parse(b.log.find((e) => e.type === "compaction")?.data);
      expect(compaction.firstMessage).toContain(`Plan file: ${plan}`);
      expect(compaction.firstMessage).toContain("PLAN BODY: change the lexer first");
      const final = model.requests.at(-1)?.transcript[0];
      expect(JSON.stringify(final)).toContain("PLAN BODY: change the lexer first");
    } finally {
      await dir.dispose();
    }
  });

  // spec: tools §11.1
  test("after the plan is approved the plan still comes back with a compaction while it is being implemented", async () => {
    const dir = await project();
    try {
      const a = await run({ adapter: scripted([{ text: "first" }]).adapter, mode: "plan" }, dir);
      const plan = planFileIn(a.log) ?? "";
      await mkdir(dirname(plan), { recursive: true });
      await writeFile(plan, "APPROVED PLAN TEXT");
      const model = scripted([
        { calls: [{ name: "Read", input: { file_path: join(dir.root, ".dovet", "settings.json") } }], usage: big },
        { text: "after" },
      ]);
      const b = await run(
        { adapter: model.adapter, continued: true, mode: "acceptEdits", prompt: "go", ids: sequentialIds("D") },
        dir,
      );
      const compaction = CompactionData.parse(b.log.find((e) => e.type === "compaction")?.data);
      expect(compaction.firstMessage).toContain("APPROVED PLAN TEXT");
      expect(compaction.firstMessage).toContain("Permission mode: acceptEdits");
    } finally {
      await dir.dispose();
    }
  });

  // spec: tools §11.1
  test("a session that never planned has no plan section in its compaction", async () => {
    const dir = await project();
    try {
      const model = scripted([
        { calls: [{ name: "Read", input: { file_path: join(dir.root, ".dovet", "settings.json") } }], usage: big },
        { text: "after" },
      ]);
      const { log } = await run({ adapter: model.adapter }, dir);
      const compaction = CompactionData.parse(log.find((e) => e.type === "compaction")?.data);
      expect(compaction.firstMessage).not.toContain("Plan file");
    } finally {
      await dir.dispose();
    }
  });
});

describe("the plan file in a fork", () => {
  // spec: tools §11.1
  test("a fork resumes in plan mode with its own copy of the plan, which the model is shown; the parent's plan is not touched", async () => {
    const dir = await project();
    try {
      const a = await run({ adapter: scripted([{ text: "first" }]).adapter, mode: "plan" }, dir);
      const parentPlan = planFileIn(a.log) ?? "";
      await mkdir(dirname(parentPlan), { recursive: true });
      await writeFile(parentPlan, "PLAN V1");
      const fork = sequentialIds("F").ulid();
      await forkAtTurn(a.loc, fork, 1, { ids: sequentialIds("G"), clock: { now: () => NOW } });
      const model = scripted([
        { calls: [{ name: "Write", input: { file_path: parentPlan, content: "PARENT EDITED" } }] },
        { text: "done" },
      ]);
      const b = await run({ adapter: model.adapter, prompt: "carry on", resume: fork, ids: sequentialIds("H") }, dir);
      const copy = planFileIn(b.log) ?? "";
      expect(copy).not.toBe(parentPlan);
      expect(copy).toStartWith(planDir({ ...b.loc, session: fork }));
      expect(await readFile(copy, "utf8")).toBe("PLAN V1");
      expect(JSON.stringify(model.requests[0]?.transcript)).toContain(
        JSON.stringify(`The current plan (${copy}):\nPLAN V1`).slice(1, -1),
      );
      expect(results(b.log).at(-1)?.status).not.toBe("ok");
      expect(await readFile(parentPlan, "utf8")).toBe("PLAN V1");
      const c = await run(
        { adapter: scripted([{ text: "again" }]).adapter, resume: fork, prompt: "more", ids: sequentialIds("J") },
        dir,
      );
      expect(c.log.filter((e) => e.type === "system.injected")).toHaveLength(1);
    } finally {
      await dir.dispose();
    }
  });
});
