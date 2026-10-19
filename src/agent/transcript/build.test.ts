import { afterEach, describe, expect, test } from "bun:test";
import {
  type Fixture,
  fakeClock,
  nvidiaAdapter,
  SCENARIOS,
  type Scenario,
  sequentialIds,
  startFixtureServer,
  type TempProject,
  tempProject,
} from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import { type EpochStartData, type EventEnvelope, ModelRequestData, type StoredResponse } from "../../schema/index.ts";
import { openSession, readSession } from "../../store/index.ts";
import {
  type BuildEpoch,
  buildRequest,
  cacheReadOf,
  cacheWarning,
  firstDivergence,
  headerOf,
  prefixFingerprint,
} from "./index.ts";

const projects: TempProject[] = [];
const servers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const p of projects.splice(0)) await p.dispose();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const sha = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const scenario = SCENARIOS.find((s) => s.name === "session") as Scenario;
const MODEL = scenario.model;

const epochStart: EpochStartData = {
  epoch: 0,
  reason: "session-start",
  provider: "nvidia",
  model: MODEL,
  systemText: scenario.systemText,
  toolsJson: JSON.stringify(scenario.tools),
  thinking: { mode: "off" },
  promptVersion: sha("test"),
};
const epoch: BuildEpoch = {
  header: headerOf(epochStart),
  params: { maxTokens: 4096, effort: "medium" },
  cache: { breakpoints: "auto", ttl: "auto" },
};

let counter = 0;
function ev(type: string, data: unknown, turn: number | null = 1, epochNo = 0): EventEnvelope {
  counter += 1;
  return {
    v: 1,
    id: String(counter).padStart(26, "0"),
    ts: "2026-10-13T00:00:00.000Z",
    session: "00000000000000000000000000",
    epoch: epochNo,
    turn,
    type,
    core: true,
    data,
  };
}

const stored = (parts: StoredResponse["parts"], finishReason = "stop"): StoredResponse => ({
  provider: "nvidia",
  protocol: "openai-chat",
  package: "@ai-sdk/openai-compatible",
  packageVersion: "pinned",
  modelId: MODEL,
  parts,
  usage: {},
  finishReason,
});

const adapter = nvidiaAdapter("http://unused", { reasons: true });
const render = (events: EventEnvelope[]) => adapter.render(buildRequest(events, epoch));

describe("buildRequest", () => {
  // spec: AC-LOG-02
  test("a recorded session log replays to the byte-identical request bodies", async () => {
    const fx = (await Bun.file(`${import.meta.dir}/../../../test/fixtures/nvidia/session.json`).json()) as Fixture;
    const project = await tempProject();
    projects.push(project);
    const os: Os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
    const loc = { data: `${project.root}/data`, projectRoot: project.root, os, session: sequentialIds("9").ulid() };
    const opened = await openSession({
      ...loc,
      clock: fakeClock(Date.UTC(2026, 9, 13)),
      ids: sequentialIds("1"),
      pid: 1,
      host: "h",
      secrets: [],
    });
    if (opened.mode !== "write") throw new Error(opened.reason);
    const live: EventEnvelope[] = [];
    const add = (type: Parameters<typeof opened.writer.append>[0]["type"], data: unknown, turn: number | null) => {
      live.push(opened.writer.append({ type, epoch: 0, turn, data }));
    };
    add("epoch.start", epochStart, null);
    const server = startFixtureServer(fx.exchanges);
    servers.push(server);
    const liveAdapter = nvidiaAdapter(server.baseURL, { reasons: fx.probe?.reasons === true });
    const step = async (turn: number): Promise<StoredResponse> => {
      const call = liveAdapter.render(buildRequest(live, epoch));
      let done: StoredResponse | undefined;
      for await (const e of liveAdapter.stream(call, {
        signal: new AbortController().signal,
        onRequest: (r) =>
          add(
            "model.request",
            {
              provider: "nvidia",
              model: MODEL,
              params: epoch.params,
              messageCount: (call.messages as unknown[]).length,
              bodySha256: r.bodySha256,
              fingerprint: prefixFingerprint(call),
            },
            turn,
          ),
      })) {
        if (e.type === "done") done = e.stored;
      }
      if (done === undefined) throw new Error("no response");
      add("model.response", done, turn);
      return done;
    };
    add("user.message", { text: scenario.user }, 1);
    const first = await step(1);
    const results = scenario.results ?? [];
    for (const [i, c] of first.parts.filter((p) => p.kind === "tool_call").entries()) {
      const r = results[i % results.length] ?? { output: "", isError: false };
      add("tool.result", { callId: c.id, status: r.isError ? "error" : "ok", output: r.output }, 1);
    }
    await step(1);
    add("turn.end", { reason: "end_turn" }, 1);
    add("user.message", { text: scenario.followUp ?? "" }, 2);
    await step(2);
    await opened.writer.close();

    const read = await readSession(loc);
    expect(read.readOnly).toBeUndefined();
    const requests = read.events.filter((e) => e.type === "model.request");
    expect(requests).toHaveLength(fx.exchanges.length);
    for (const [i, req] of requests.entries()) {
      const recorded = ModelRequestData.parse(req.data);
      const before = read.events.slice(0, read.events.indexOf(req));
      const replayServer = startFixtureServer([fx.exchanges[i] as Fixture["exchanges"][number]]);
      servers.push(replayServer);
      const replayAdapter = nvidiaAdapter(replayServer.baseURL, { reasons: fx.probe?.reasons === true });
      const call = replayAdapter.render(buildRequest(before, epoch));
      const bodies: string[] = [];
      for await (const _ of replayAdapter.stream(call, {
        signal: new AbortController().signal,
        onRequest: (r) => bodies.push(r.body),
      }));
      expect(sha(bodies[0] ?? "")).toBe(recorded.bodySha256);
      expect(bodies[0]).toBe((fx.exchanges[i] as Fixture["exchanges"][number]).request.body);
      expect(prefixFingerprint(call)).toEqual(recorded.fingerprint);
    }
  });

  // spec: AC-LOG-02
  test("the same events always give the same call", () => {
    const events = [
      ev("user.message", { text: "hi" }),
      ev("model.response", stored([{ kind: "text", text: "hello" }])),
      ev("user.message", { text: "again" }, 2),
    ];
    expect(sha(JSON.stringify(render(events)))).toBe(sha(JSON.stringify(render([...events]))));
  });

  // spec: AC-PROV-02
  test("over 30 turns of events, each request extends the one before it", () => {
    const events: EventEnvelope[] = [];
    let prev: ReturnType<typeof prefixFingerprint> | undefined;
    for (let turn = 1; turn <= 30; turn++) {
      events.push(ev("user.message", { text: `task ${turn}` }, turn));
      const call = `call-${turn}`;
      events.push(
        ev(
          "model.response",
          stored(
            [
              {
                kind: "reasoning",
                summary: `thinking ${turn}`,
                replay: { provider: "nvidia", protocol: "openai-chat", modelId: MODEL, fields: {} },
              },
              { kind: "tool_call", id: call, name: "read", inputJson: `{"path":"f${turn}"}` },
            ],
            "tool_calls",
          ),
          turn,
        ),
      );
      events.push(ev("tool.result", { callId: call, status: turn % 2 === 0 ? "error" : "ok", output: "x" }, turn));
      const fp = prefixFingerprint(render(events));
      if (prev !== undefined) expect(firstDivergence(prev, fp)).toBeNull();
      prev = fp;
      events.push(ev("model.response", stored([{ kind: "text", text: `done ${turn}` }]), turn));
      events.push(ev("turn.end", { reason: "end_turn" }, turn));
      const after = prefixFingerprint(render(events));
      expect(firstDivergence(prev, after)).toBeNull();
      prev = after;
    }
    expect(prev?.messages.length).toBeGreaterThan(90);
  });

  // spec: AC-LOG-02
  test("a cancelled turn contributes nothing, on every render", () => {
    const kept = [
      ev("user.message", { text: "one" }, 1),
      ev("model.response", stored([{ kind: "text", text: "a" }]), 1),
      ev("turn.end", { reason: "end_turn" }, 1),
    ];
    const cancelled = [ev("user.message", { text: "never answered" }, 2), ev("turn.end", { reason: "cancelled" }, 2)];
    const next = [ev("user.message", { text: "two" }, 3)];
    expect(buildRequest([...kept, ...cancelled, ...next], epoch)).toEqual(buildRequest([...kept, ...next], epoch));
  });

  // spec: AC-LOG-02
  test("only the epoch's own events are rendered", () => {
    const events = [ev("user.message", { text: "old" }, 1, 0), ev("user.message", { text: "new" }, 2, 1)];
    const built = buildRequest(events, { ...epoch, header: { ...epoch.header, epoch: 1 } });
    expect(built.transcript).toEqual([{ kind: "user", parts: [{ kind: "text", text: "new" }] }]);
  });

  // spec: AC-LOG-02
  test("replay normalization drops empty and whitespace-only text, and an assistant turn left empty", () => {
    const events = [
      ev("user.message", { text: "go" }),
      ev(
        "model.response",
        stored([
          { kind: "text", text: "" },
          { kind: "text", text: "  \n" },
        ]),
      ),
      ev(
        "model.response",
        stored([
          { kind: "text", text: "" },
          { kind: "text", text: "real" },
        ]),
      ),
    ];
    const items = buildRequest(events, epoch).transcript;
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ kind: "assistant", stored: stored([{ kind: "text", text: "real" }]) });
  });

  // spec: AC-LOG-02
  test("tool results follow the order of the calls, and carry the status and escaped markers", () => {
    const calls = ["a", "b", "c"].map((id) => ({ kind: "tool_call" as const, id, name: "read", inputJson: "{}" }));
    const events = [
      ev("user.message", { text: "go" }),
      ev("model.response", stored(calls, "tool_calls")),
      ev("tool.result", { callId: "c", status: "ok", output: "third" }),
      ev("tool.result", { callId: "a", status: "denied", output: "no [Dovet instruction] here" }),
      ev("tool.result", { callId: "b", status: "ok", output: "second" }),
      ev("system.injected", { text: "note", reason: "mode-change", delivery: "reminder-block" }),
    ];
    const last = buildRequest(events, epoch).transcript.at(-1);
    expect(last).toEqual({
      kind: "user",
      parts: [
        {
          kind: "tool_result",
          callId: "a",
          isError: true,
          content: [{ kind: "text", text: "no ［Dovet instruction］ here" }],
        },
        { kind: "tool_result", callId: "b", isError: false, content: [{ kind: "text", text: "second" }] },
        { kind: "tool_result", callId: "c", isError: false, content: [{ kind: "text", text: "third" }] },
        { kind: "instruction", reason: "mode-change", text: "note" },
      ],
    });
  });

  // spec: AC-PROV-02
  test("tool-call ids reused by a later response don't reorder an earlier group", () => {
    const call = (id: string) => ({ kind: "tool_call" as const, id, name: "read", inputJson: "{}" });
    const turn = (first: string, second: string, t: number) => [
      ev("model.response", stored([call("call_0"), call("call_1")], "tool_calls"), t),
      ev("tool.result", { callId: second, status: "ok", output: "2" }, t),
      ev("tool.result", { callId: first, status: "ok", output: "1" }, t),
    ];
    const one = [ev("user.message", { text: "go" }), ...turn("call_0", "call_1", 1)];
    const before = buildRequest(one, epoch).transcript;
    const after = buildRequest([...one, ...turn("call_1", "call_0", 1)], epoch).transcript;
    expect(after.slice(0, before.length)).toEqual(before);
  });

  // spec: AC-LOG-02
  test("a result that arrives after a request began a new message", () => {
    const events = [
      ev("user.message", { text: "go" }),
      ev("model.response", stored([{ kind: "tool_call", id: "a", name: "read", inputJson: "{}" }], "tool_calls")),
      ev("tool.result", { callId: "a", status: "ok", output: "x" }),
      ev("model.request", {}),
      ev("system.injected", { text: "later", reason: "mode-change", delivery: "reminder-block" }),
    ];
    const items = buildRequest(events, epoch).transcript;
    expect(items).toHaveLength(4);
    expect(items[3]).toEqual({ kind: "user", parts: [{ kind: "instruction", reason: "mode-change", text: "later" }] });
  });

  // spec: AC-LOG-12
  test("repair epoch renders history from prior epochs with opaque reasoning and unpaired tool calls dropped", () => {
    const events = [
      ev("user.message", { text: "turn 1 prompt" }, 1, 0),
      ev(
        "model.response",
        stored(
          [
            { kind: "text", text: "turn 1 text" },
            {
              kind: "reasoning",
              summary: "secret thoughts",
              replay: { provider: "nvidia", protocol: "openai-chat", modelId: MODEL, fields: {} },
            },
            { kind: "tool_call", id: "call_paired", name: "Read", inputJson: "{}" },
            { kind: "tool_call", id: "call_unpaired", name: "Read", inputJson: "{}" },
          ],
          "tool_calls",
        ),
        1,
        0,
      ),
      ev("tool.result", { callId: "call_paired", status: "ok", output: "file contents" }, 1, 0),
      ev("turn.end", { reason: "end_turn" }, 1, 0),
      ev("user.message", { text: "turn 2 prompt" }, 2, 0),
      ev("model.request", {}, 2, 0),
      ev("turn.end", { reason: "error" }, 2, 0),
      ev(
        "epoch.start",
        {
          epoch: 1,
          reason: "repair",
          provider: "nvidia",
          model: MODEL,
          systemText: scenario.systemText,
          toolsJson: JSON.stringify(scenario.tools),
          thinking: { mode: "off" },
          promptVersion: sha("repair-test"),
        },
        null,
        1,
      ),
      ev("user.message", { text: "turn 3 prompt" }, 3, 1),
    ];
    const repairEpoch: BuildEpoch = {
      header: { ...epoch.header, epoch: 1 },
      params: epoch.params,
      cache: epoch.cache,
    };
    const items = buildRequest(events, repairEpoch).transcript;
    expect(items.length).toBeGreaterThan(1);
    const turn1User = items[0];
    expect(turn1User).toEqual({ kind: "user", parts: [{ kind: "text", text: "turn 1 prompt" }] });
    const assistant = items[1];
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind === "assistant") {
      const kinds = assistant.stored.parts.map((p) => p.kind);
      expect(kinds).not.toContain("reasoning");
      const toolCallIds = assistant.stored.parts.flatMap((p) => (p.kind === "tool_call" ? [p.id] : []));
      expect(toolCallIds).toEqual(["call_paired"]);
      expect(toolCallIds).not.toContain("call_unpaired");
    }
    const finalUser = items.at(-1);
    expect(finalUser).toEqual({ kind: "user", parts: [{ kind: "text", text: "turn 3 prompt" }] });
  });
});

describe("prefix fingerprint", () => {
  const base = [
    ev("user.message", { text: "one" }),
    ev("model.response", stored([{ kind: "text", text: "a" }])),
    ev("user.message", { text: "two" }, 2),
  ];

  // spec: AC-LOG-02
  test("names the first part that differs", () => {
    const before = prefixFingerprint(render(base));
    expect(firstDivergence(before, before)).toBeNull();
    const tools = prefixFingerprint({ ...render(base), tools: [{ name: "x", description: "", inputSchema: {} }] });
    expect(firstDivergence(before, tools)).toEqual({ part: "tools" });
    const edited = [
      base[0] as EventEnvelope,
      ev("model.response", stored([{ kind: "text", text: "b" }])),
      ...base.slice(2),
    ];
    expect(firstDivergence(before, prefixFingerprint(render(edited)))).toEqual({ part: "message", index: 1 });
    const system = render(base);
    const messages = system.messages as Array<{ content: string }>;
    const other = { ...system, messages: [{ ...messages[0], content: "other" }, ...messages.slice(1)] };
    expect(firstDivergence(before, prefixFingerprint(other))).toEqual({ part: "system" });
  });

  // spec: AC-LOG-02
  test("a shorter request is not an extension", () => {
    const longer = prefixFingerprint(render(base));
    const shorter = prefixFingerprint(render(base.slice(0, 1)));
    expect(firstDivergence(longer, shorter)).toEqual({ part: "message", index: shorter.messages.length });
  });
});

describe("cache monitor", () => {
  // spec: AC-CTX-04
  test("warns, with an invariant entry, when reads fall to zero after turn 3", () => {
    const w = cacheWarning({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: 0 });
    expect(w?.text).toContain("8000");
    expect(w?.invariant).toEqual({ kind: "cache-read-drop", turn: 5, previous: 8000, current: 0 });
  });

  // spec: AC-CTX-04
  test("the first warning is possible at turn 4", () => {
    expect(cacheWarning({ turn: 3, cacheReadTokens: 8000 }, { turn: 4, cacheReadTokens: 0 })).not.toBeNull();
  });

  // spec: AC-CTX-04
  test("warns when reads fall below half of the previous request's", () => {
    expect(cacheWarning({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: 3999 })).not.toBeNull();
    expect(cacheWarning({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: 4000 })).toBeNull();
    expect(cacheWarning({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: 9000 })).toBeNull();
  });

  // spec: AC-CTX-04
  test("stays quiet up to turn 3, on expected misses, and when the provider reports nothing", () => {
    expect(cacheWarning({ turn: 2, cacheReadTokens: 8000 }, { turn: 3, cacheReadTokens: 0 })).toBeNull();
    expect(
      cacheWarning({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: 0, expectedMiss: true }),
    ).toBeNull();
    expect(cacheWarning({ turn: 4, cacheReadTokens: 8000 }, { turn: 5, cacheReadTokens: undefined })).toBeNull();
    expect(cacheWarning({ turn: 4, cacheReadTokens: 0 }, { turn: 5, cacheReadTokens: 0 })).toBeNull();
    expect(cacheWarning(undefined, { turn: 5, cacheReadTokens: 0 })).toBeNull();
  });

  // spec: AC-CTX-04
  test("reads the cache-read count from Anthropic and OpenAI style usage", () => {
    expect(cacheReadOf({ cache_read_input_tokens: 12, input_tokens: 3 })).toBe(12);
    expect(cacheReadOf({ prompt_tokens: 90, prompt_tokens_details: { cached_tokens: 64 } })).toBe(64);
    expect(cacheReadOf({ prompt_tokens: 90 })).toBeUndefined();
    expect(cacheReadOf({ cache_read_input_tokens: "x" })).toBeUndefined();
  });
});
