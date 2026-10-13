import { afterEach, describe, expect, test } from "bun:test";
import { APICallError, type ModelMessage, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  type Fixture,
  nvidiaAdapter,
  renderInput,
  SCENARIOS,
  type Scenario,
  scriptedModel,
  sseBody,
  startFixtureServer,
} from "../../test/helpers/index.ts";
import type { StoredResponse } from "../schema/index.ts";
import { capturingFetch, createSdkAdapter, type ProviderRequest, type RenderInput, type StreamEvent } from "./index.ts";
import { endpointOf, providerRecord } from "./registry.ts";

const servers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function fixture(name: string): Promise<Fixture> {
  return (await Bun.file(`${import.meta.dir}/../../test/fixtures/nvidia/${name}.json`).json()) as Fixture;
}

function scenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  return s;
}

const NVIDIA = endpointOf(providerRecord("nvidia"));
const input = renderInput;

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function storedOf(events: StreamEvent[]): StoredResponse {
  const done = events.find((e) => e.type === "done");
  if (done?.type !== "done") throw new Error(`no done event: ${JSON.stringify(events.at(-1))}`);
  return done.stored;
}

type Chunk = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer C> ? C : never;
const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function chunkModel(chunks: Chunk[]) {
  return new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({ stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) }),
  });
}

function scripted(model: MockLanguageModelV4) {
  return createSdkAdapter({
    endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
    model: () => model,
  });
}

async function runOnce(adapter: ReturnType<typeof scripted>): Promise<StreamEvent[]> {
  const s = scenario("parallel-tools");
  return collect(
    adapter.stream(adapter.render(input(s, [{ kind: "user", parts: [{ kind: "text", text: "go" }] }])), {
      signal: new AbortController().signal,
      onRequest: () => {},
    }),
  );
}

describe("render", () => {
  test("is deterministic, and sends the tools sorted by name", () => {
    const adapter = nvidiaAdapter("http://unused");
    const s = scenario("parallel-tools");
    const a = adapter.render(input(s, [{ kind: "user", parts: [{ kind: "text", text: "hi" }] }]));
    const b = adapter.render(input(s, [{ kind: "user", parts: [{ kind: "text", text: "hi" }] }]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tools.map((t) => t.name)).toEqual(["list", "read"]);
    expect(a.messages).toEqual([
      { role: "system", content: s.systemText },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("another provider's turn is replayed without its reasoning, and its tool-call ids are mapped", () => {
    const adapter = nvidiaAdapter("http://unused");
    const s = scenario("parallel-tools");
    const replay = { provider: "example", protocol: "openai-chat" as const, modelId: "other/model", fields: {} };
    const stored: StoredResponse = {
      provider: "example",
      protocol: "openai-chat",
      package: "@ai-sdk/openai-compatible",
      packageVersion: "x",
      modelId: "other/model",
      parts: [
        { kind: "reasoning", summary: "thinking", replay },
        { kind: "tool_call", id: "call-1", name: "read", inputJson: '{"path":"a"}', replay },
      ],
      usage: {},
      finishReason: "tool-calls",
    };
    const call = adapter.render(
      input(s, [
        { kind: "assistant", stored },
        {
          kind: "user",
          parts: [{ kind: "tool_result", callId: "call-1", isError: true, content: [{ kind: "text", text: "A" }] }],
        },
      ]),
    );
    const mapped = `dovet_${new Bun.CryptoHasher("sha256").update("call-1").digest("hex").slice(0, 24)}`;
    expect((call.messages as ModelMessage[]).slice(1)).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: mapped, toolName: "read", input: { path: "a" } }],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: mapped, toolName: "read", output: { type: "error-text", value: "A" } },
        ],
      },
    ]);
  });
});

// spec: providers "Effort mapping" (chat fallback: quirk effortField)
describe("effort", () => {
  const s = scenario("text");
  const first: RenderInput["transcript"] = [{ kind: "user", parts: [{ kind: "text", text: "hi" }] }];
  const sent = (adapter: ReturnType<typeof nvidiaAdapter>, effort: string) => {
    const call = adapter.render(input(s, first, effort));
    return { effort: call.effort, providerOptions: call.providerOptions };
  };

  test("a reasoning model gets reasoning_effort with the level asked for", () => {
    expect(sent(nvidiaAdapter("http://unused", { reasons: true }), "low")).toEqual({
      effort: "low",
      providerOptions: { nvidia: { reasoningEffort: "low" } },
    });
  });

  test("a model the probe found not reasoning gets no effort field at all", () => {
    expect(sent(nvidiaAdapter("http://unused"), "high")).toEqual({ effort: undefined, providerOptions: {} });
  });

  test("an unsupported level maps to the nearest lower one, max to the highest, and the sent value is reported", () => {
    const adapter = nvidiaAdapter("http://unused", { reasons: true, levels: ["low", "high"] });
    expect(sent(adapter, "medium").effort).toBe("low");
    expect(sent(adapter, "xhigh").effort).toBe("high");
    expect(sent(adapter, "max")).toEqual({ effort: "high", providerOptions: { nvidia: { reasoningEffort: "high" } } });
    expect(sent(nvidiaAdapter("http://unused", { reasons: true, levels: ["high"] }), "low").effort).toBe("high");
  });

  test("an endpoint without an effort field gets none", () => {
    const adapter = createSdkAdapter({
      endpoint: () => ({ ...NVIDIA, baseURL: "http://unused", quirks: { ...NVIDIA.quirks, effortField: null } }),
      modelInfo: () => ({ effortLevels: ["low"] }),
    });
    expect(sent(adapter, "low")).toEqual({ effort: undefined, providerOptions: {} });
  });
});

// spec: providers §6 "Reasoning replay for chat-protocol reasoning models" (quirk reasoningReplay)
describe("reasoning replay on chat endpoints", () => {
  const s = scenario("parallel-tools");
  const turn = (id: string): StoredResponse => {
    const replay = { provider: "nvidia", protocol: "openai-chat" as const, modelId: s.model, fields: {} };
    return {
      provider: "nvidia",
      protocol: "openai-chat",
      package: "@ai-sdk/openai-compatible",
      packageVersion: "x",
      modelId: s.model,
      parts: [
        { kind: "reasoning", summary: `thinking ${id}`, replay },
        { kind: "tool_call", id, name: "read", inputJson: '{"path":"a"}' },
      ],
      usage: {},
      finishReason: "tool_calls",
    };
  };
  const result = (id: string) => ({
    kind: "user" as const,
    parts: [
      { kind: "tool_result" as const, callId: id, isError: false, content: [{ kind: "text" as const, text: "A" }] },
    ],
  });
  const transcript: RenderInput["transcript"] = [
    { kind: "user", parts: [{ kind: "text", text: "one" }] },
    { kind: "assistant", stored: turn("c1") },
    result("c1"),
    { kind: "user", parts: [{ kind: "text", text: "two" }] },
    { kind: "assistant", stored: turn("c2") },
    result("c2"),
  ];
  const reasoningSent = (replay: "in-tool-loop" | "always" | "never" | undefined, items = transcript) => {
    const { reasoningReplay: _, ...rest } = NVIDIA.quirks;
    const quirks = replay === undefined ? rest : { ...rest, reasoningReplay: replay };
    const adapter = createSdkAdapter({ endpoint: () => ({ ...NVIDIA, baseURL: "http://unused", quirks }) });
    return (adapter.render(input(s, items)).messages as ModelMessage[]).flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content.flatMap((p) => (p.type === "reasoning" ? [p.text] : []))
        : [],
    );
  };

  test("in-tool-loop: only the current tool loop's reasoning goes back; an earlier user turn's is dropped", () => {
    expect(reasoningSent("in-tool-loop")).toEqual(["thinking c2"]);
  });

  test("in-tool-loop: text queued after tool results stays in the loop and keeps the reasoning", () => {
    const queued = [
      ...transcript.slice(0, 2),
      { kind: "user" as const, parts: [...result("c1").parts, { kind: "text" as const, text: "also check B" }] },
    ];
    expect(reasoningSent("in-tool-loop", queued)).toEqual(["thinking c1"]);
  });

  test("always and never; a record without the quirk replays always", () => {
    expect(reasoningSent("always")).toEqual(["thinking c1", "thinking c2"]);
    expect(reasoningSent("never")).toEqual([]);
    expect(reasoningSent(undefined)).toEqual(["thinking c1", "thinking c2"]);
  });
});

// spec: providers §6 (tool calls stream as fragments keyed by index)
describe("tool-call fragments", () => {
  const delta = (d: unknown, finish: string | null = null) => ({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "example/model",
    choices: [{ index: 0, delta: d, finish_reason: finish }],
  });
  const call = (index: number, fn: Record<string, string>, id?: string) => ({
    tool_calls: [{ index, ...(id === undefined ? {} : { id, type: "function" }), function: fn }],
  });

  test("two parallel calls whose arguments arrive interleaved in pieces are put back together per index", async () => {
    const body = sseBody([
      delta(call(0, { name: "read", arguments: "" }, "call-a")),
      delta(call(1, { name: "list", arguments: '{"pa' }, "call-b")),
      delta(call(0, { arguments: '{"path":' })),
      delta(call(1, { arguments: 'th":"src"}' })),
      delta(call(0, { arguments: '"README.md"}' })),
      delta({}, "tool_calls"),
    ]);
    const server = startFixtureServer([
      {
        request: { path: "/v1/chat/completions", body: "" },
        response: { status: 200, contentType: "text/event-stream", body },
      },
    ]);
    servers.push(server);
    const adapter = nvidiaAdapter(server.baseURL);
    const events = await collect(
      adapter.stream(
        adapter.render(input(scenario("parallel-tools"), [{ kind: "user", parts: [{ kind: "text", text: "go" }] }])),
        { signal: new AbortController().signal, onRequest: () => {} },
      ),
    );
    const calls = storedOf(events).parts.flatMap((p) =>
      p.kind === "tool_call" ? [[p.id, p.name, JSON.parse(p.inputJson)]] : [],
    );
    expect(calls).toEqual([
      ["call-a", "read", { path: "README.md" }],
      ["call-b", "list", { path: "src" }],
    ]);
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "tool_use" });
  });
});

describe("replay rule", () => {
  const adapter = nvidiaAdapter("http://unused");
  const s = scenario("parallel-tools");
  const meta = { nvidia: { signature: "sig-1" } };
  const stored = (modelId: string): StoredResponse => {
    const replay = { provider: "nvidia", protocol: "openai-chat" as const, modelId, fields: meta };
    return {
      provider: "nvidia",
      protocol: "openai-chat",
      package: "@ai-sdk/openai-compatible",
      packageVersion: "x",
      modelId,
      parts: [
        { kind: "reasoning", summary: "thinking", replay },
        { kind: "text", text: "Looking.", replay },
        { kind: "tool_call", id: "call-1", name: "read", inputJson: '{"path":"a"}', replay },
      ],
      usage: {},
      finishReason: "tool_calls",
    };
  };

  test("the same model gets its turn back with reasoning and provider data", () => {
    expect(adapter.fromStored(stored(s.model), { provider: "nvidia", model: s.model })).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: meta },
          { type: "text", text: "Looking.", providerOptions: meta },
          { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" }, providerOptions: meta },
        ],
      },
    ]);
  });

  test("another model of the same provider gets no reasoning or provider data, and the ids unchanged", () => {
    expect(adapter.fromStored(stored("other/model"), { provider: "nvidia", model: s.model })).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" } },
        ],
      },
    ]);
  });

  test("provider data on every kind of part survives the round trip", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "r", providerOptions: meta },
          { type: "text", text: "t", providerOptions: meta },
          { type: "tool-call", toolCallId: "c", toolName: "read", input: { path: "x" }, providerOptions: meta },
        ],
      },
    ];
    const ctx = { provider: "nvidia", package: "@ai-sdk/openai-compatible", packageVersion: "x", modelId: s.model };
    expect(adapter.fromStored(adapter.toStored({ messages }, ctx), { provider: "nvidia", model: s.model })).toEqual(
      messages,
    );
  });
});

describe("tool calls the model got wrong", () => {
  for (const [what, call] of [
    ["malformed arguments", { type: "tool-call", toolCallId: "c1", toolName: "read", input: "{bad" }],
    ["an unknown tool", { type: "tool-call", toolCallId: "c1", toolName: "nope", input: '{"path":"a"}' }],
  ] as const) {
    test(`${what}: the step still ends with a stored call holding the model's raw text`, async () => {
      const events = await runOnce(
        scripted(
          chunkModel([
            call,
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE },
          ]),
        ),
      );
      const stored = storedOf(events);
      expect(stored.parts).toEqual([{ kind: "tool_call", id: "c1", name: call.toolName, inputJson: call.input }]);
      expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "tool_use" });
    });
  }
});

describe("stop reasons", () => {
  for (const [unified, raw, expected] of [
    ["stop", "stop", "end_turn"],
    ["length", "length", "max_tokens"],
    ["content-filter", "content_filter", "refusal"],
    ["other", "weird", { other: "other" }],
  ] as const) {
    test(`${raw} → ${JSON.stringify(expected)}, and the raw reason is stored`, async () => {
      const events = await runOnce(
        scripted(
          chunkModel([
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "x" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified, raw }, usage: USAGE },
          ]),
        ),
      );
      expect(events.find((e) => e.type === "done")).toMatchObject({
        stopReason: expected,
        stored: { finishReason: raw },
      });
    });
  }
});

describe("capturingFetch", () => {
  const ok: typeof fetch = Object.assign(() => Promise.resolve(new Response("ok")), { preconnect: fetch.preconnect });

  test("records byte bodies exactly and the headers of a Request, with credentials redacted", async () => {
    const seen: ProviderRequest[] = [];
    const f = capturingFetch((r) => seen.push(r), ok);
    const req = new Request("http://h/v1", { headers: { authorization: "Bearer nvapi-FAKE", "x-trace": "1" } });
    await f(req, { body: new TextEncoder().encode('{"a":1}'), headers: { "content-type": "application/json" } });
    expect(seen[0]).toEqual({
      url: "http://h/v1",
      headers: { authorization: "[redacted]", "x-trace": "1", "content-type": "application/json" },
      body: '{"a":1}',
      bodySha256: new Bun.CryptoHasher("sha256").update('{"a":1}').digest("hex"),
    });
  });

  test("a body it can't record exactly is refused", () => {
    const f = capturingFetch(() => {}, ok);
    expect(() => f("http://h", { body: new FormData() })).toThrow("can't be recorded exactly");
  });
});

describe("recorded NVIDIA sessions", () => {
  test("session: the recording has effort, reasoning, two parallel calls, an error result and a follow-up keeping it", async () => {
    const fx = await fixture("session");
    const [first, loop, followUp] = fx.exchanges.map((x) => JSON.parse(x.request.body));
    expect(fx.probe).toMatchObject({ reasons: true });
    expect(first.reasoning_effort).toBe(scenario("session").effort);
    const assistant = loop.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.reasoning_content.length).toBeGreaterThan(0);
    expect(assistant.tool_calls).toHaveLength(2);
    expect(loop.messages.filter((m: { role: string }) => m.role === "tool")).toHaveLength(2);
    expect(followUp.messages.filter((m: { role: string }) => m.role === "user")).toHaveLength(2);
    // The record replays reasoning always (QUESTIONS Q27), so the follow-up still carries the tool loop's reasoning.
    expect(followUp.messages.some((m: { reasoning_content?: string }) => m.reasoning_content !== undefined)).toBe(true);
  });

  test("text: deltas add up to the stored text and every block is closed", async () => {
    const fx = await fixture("text");
    const server = startFixtureServer(fx.exchanges);
    servers.push(server);
    const s = scenario("text");
    const adapter = nvidiaAdapter(server.baseURL);
    const events = await collect(
      adapter.stream(adapter.render(input(s, [{ kind: "user", parts: [{ kind: "text", text: s.user }] }])), {
        signal: new AbortController().signal,
        onRequest: () => {},
      }),
    );
    const stored = storedOf(events);
    const text = stored.parts.find((p) => p.kind === "text");
    const deltas = events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
    expect(text?.kind === "text" ? text.text : undefined).toBe(deltas);
    const opened = new Set(events.flatMap((e) => ("blockIndex" in e && e.type !== "block.done" ? [e.blockIndex] : [])));
    const closed = new Set(events.flatMap((e) => (e.type === "block.done" ? [e.blockIndex] : [])));
    expect(closed).toEqual(opened);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });
});

describe("stream with a scripted model", () => {
  test("an abort keeps only the blocks that finished", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: ({ abortSignal }) =>
        Promise.resolve({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "text-start", id: "t1" });
              c.enqueue({ type: "text-delta", id: "t1", delta: "done block" });
              c.enqueue({ type: "text-end", id: "t1" });
              c.enqueue({ type: "text-start", id: "t2" });
              c.enqueue({ type: "text-delta", id: "t2", delta: "half" });
              abortSignal?.addEventListener("abort", () => c.error(abortSignal.reason));
            },
          }),
        }),
    });
    const adapter = createSdkAdapter({
      endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
      model: () => model,
    });
    const s = scenario("text");
    const events: StreamEvent[] = [];
    for await (const e of adapter.stream(
      adapter.render(input(s, [{ kind: "user", parts: [{ kind: "text", text: "go" }] }])),
      {
        signal: controller.signal,
        onRequest: () => {},
      },
    )) {
      events.push(e);
      if (e.type === "text.delta" && e.text === "half") controller.abort();
    }
    const last = events.at(-1);
    expect(last?.type).toBe("aborted");
    if (last?.type !== "aborted") return;
    expect(last.completed?.parts).toEqual([{ kind: "text", text: "done block" }]);
  });

  test("a provider error becomes an error event with its classification", async () => {
    const adapter = createSdkAdapter({
      endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
      model: () =>
        scriptedModel([
          {
            error: new APICallError({
              message: "slow down",
              url: "u",
              requestBodyValues: {},
              statusCode: 429,
              responseHeaders: { "retry-after": "3" },
              isRetryable: true,
            }),
          },
        ]),
    });
    const s = scenario("text");
    const events = await collect(
      adapter.stream(adapter.render(input(s, [{ kind: "user", parts: [{ kind: "text", text: "go" }] }])), {
        signal: new AbortController().signal,
        onRequest: () => {},
      }),
    );
    expect(events.at(-1)).toEqual({
      type: "error",
      error: { kind: "rate_limit", retryable: true, retryAfterMs: 3000, status: 429, message: "slow down" },
    });
  });
});

describe("classifyError", () => {
  const adapter = nvidiaAdapter("http://unused");
  const api = (statusCode: number, message = "m") =>
    new APICallError({ message, url: "u", requestBodyValues: {}, statusCode, isRetryable: false });

  test("maps HTTP statuses to kinds and retryability", () => {
    const kinds = [400, 401, 402, 403, 404, 410, 413, 429, 500, 503, 529].map((s) => {
      const e = adapter.classifyError(api(s));
      return [s, e.kind, e.retryable];
    });
    expect(kinds).toEqual([
      [400, "invalid_request", false],
      [401, "auth", false],
      [402, "billing", false],
      [403, "auth", false],
      [404, "not_found", false],
      [410, "not_found", false],
      [413, "too_large", false],
      [429, "rate_limit", true],
      [500, "server", true],
      [503, "overloaded", true],
      [529, "overloaded", true],
    ]);
  });

  // spec: providers "Model lifecycle" (a retired model; NVIDIA answers 410 with a problem body)
  test("an RFC 9457 problem body adds its detail to the message, once", () => {
    const err = new APICallError({
      message: "Gone",
      url: "u",
      requestBodyValues: {},
      statusCode: 410,
      responseBody: JSON.stringify({ status: 410, title: "Gone", detail: "The model reached its end of life." }),
    });
    expect(adapter.classifyError(err).message).toBe("Gone: The model reached its end of life.");
    const repeated = new APICallError({
      message: "The model reached its end of life.",
      url: "u",
      requestBodyValues: {},
      statusCode: 410,
      responseBody: JSON.stringify({ detail: "The model reached its end of life." }),
    });
    expect(adapter.classifyError(repeated).message).toBe("The model reached its end of life.");
  });

  test("a network failure is retryable; a programming error or anything else is unknown", () => {
    expect(adapter.classifyError(new TypeError("fetch failed"))).toMatchObject({ kind: "network", retryable: true });
    const reset = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    expect(adapter.classifyError(reset)).toMatchObject({ kind: "network", retryable: true });
    expect(adapter.classifyError(new TypeError("undefined is not a function"))).toMatchObject({
      kind: "unknown",
      retryable: false,
    });
    expect(adapter.classifyError("weird")).toEqual({ kind: "unknown", retryable: false, message: "weird" });
  });

  test("a timeout is retryable, the request id is kept, and the credential never reaches the message", () => {
    expect(adapter.classifyError(Object.assign(new Error("took too long"), { name: "TimeoutError" }))).toMatchObject({
      kind: "timeout",
      retryable: true,
    });
    const err = new APICallError({
      message: "bad key nvapi-FAKE-123 rejected",
      url: "u",
      requestBodyValues: {},
      statusCode: 401,
      responseHeaders: { "x-request-id": "req-9" },
    });
    expect(adapter.classifyError(err, ["nvapi-FAKE-123"])).toEqual({
      kind: "auth",
      retryable: false,
      status: 401,
      requestId: "req-9",
      message: "bad key [redacted] rejected",
    });
  });
});
