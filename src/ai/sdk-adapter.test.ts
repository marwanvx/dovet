import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, jsonSchema, type ModelMessage, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  type Fixture,
  MAX_TOKENS,
  SCENARIOS,
  type Scenario,
  scriptedModel,
  startFixtureServer,
} from "../../test/helpers/index.ts";
import type { StoredResponse } from "../schema/index.ts";
import { Secret } from "../store/index.ts";
import { createSdkAdapter, type ProviderRequest, type RenderInput, type StreamEvent } from "./index.ts";

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

function input(s: Scenario, transcript: RenderInput["transcript"]): RenderInput {
  return {
    header: {
      epoch: 0,
      provider: "nvidia",
      model: s.model,
      promptVersion: "test",
      systemText: s.systemText,
      toolsJson: JSON.stringify(s.tools),
      thinking: { mode: "off" },
    },
    params: { maxTokens: MAX_TOKENS },
    transcript,
    cache: { breakpoints: "auto", ttl: "auto" },
  };
}

function nvidiaAdapter(baseURL: string) {
  return createSdkAdapter({
    endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL, apiKey: new Secret("test-key-not-real") }),
  });
}

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
          parts: [{ kind: "tool_result", callId: "call-1", isError: false, content: [{ kind: "text", text: "A" }] }],
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
        content: [{ type: "tool-result", toolCallId: mapped, toolName: "read", output: { type: "text", value: "A" } }],
      },
    ]);
  });
});

describe("recorded NVIDIA sessions", () => {
  for (const name of ["text", "parallel-tools"]) {
    test(`${name}: every request the adapter sends equals the recorded direct-SDK request byte for byte`, async () => {
      const fx = await fixture(name);
      const s = scenario(name);
      const server = startFixtureServer(fx.exchanges);
      servers.push(server);
      const adapter = nvidiaAdapter(server.baseURL);
      const captured: ProviderRequest[] = [];
      const run = (transcript: RenderInput["transcript"]) =>
        collect(
          adapter.stream(adapter.render(input(s, transcript)), {
            signal: new AbortController().signal,
            onRequest: (r) => captured.push(r),
          }),
        );

      const first: RenderInput["transcript"] = [{ kind: "user", parts: [{ kind: "text", text: s.user }] }];
      const events = await run(first);
      const stored = storedOf(events);
      expect(stored).toMatchObject({ provider: "nvidia", protocol: "openai-chat", modelId: s.model });
      expect(stored.package).toBe("@ai-sdk/openai-compatible");
      if (s.results !== undefined) {
        const results = s.results;
        const calls = stored.parts.filter((p) => p.kind === "tool_call");
        expect(calls.length).toBeGreaterThan(0);
        expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "tool_use" });
        await run([
          ...first,
          { kind: "assistant", stored },
          {
            kind: "user",
            parts: calls.map((c, i) => {
              const r = results[i % results.length] ?? { output: "", isError: false };
              return {
                kind: "tool_result" as const,
                callId: c.id,
                isError: r.isError,
                content: [{ kind: "text" as const, text: r.output }],
              };
            }),
          },
        ]);
      } else {
        expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "end_turn" });
      }
      expect(server.received).toEqual(fx.exchanges.map((x) => x.request.body));
      expect(captured.map((c) => c.body)).toEqual(server.received);
      for (const c of captured) {
        expect(c.bodySha256).toBe(new Bun.CryptoHasher("sha256").update(c.body).digest("hex"));
        expect(JSON.stringify(c.headers)).not.toContain("test-key-not-real");
      }
    });

    test(`${name}: SDK response messages → stored parts → SDK messages is lossless`, async () => {
      const fx = await fixture(name);
      const s = scenario(name);
      const server = startFixtureServer(fx.exchanges);
      servers.push(server);
      const provider = createOpenAICompatible({
        name: "nvidia",
        baseURL: server.baseURL,
        apiKey: "x",
        includeUsage: true,
      });
      const r = streamText({
        model: provider.chatModel(s.model),
        messages: [
          { role: "system", content: s.systemText },
          { role: "user", content: [{ type: "text", text: s.user }] },
        ],
        tools: Object.fromEntries(
          s.tools.map((d) => [d.name, tool({ description: d.description, inputSchema: jsonSchema(d.inputSchema) })]),
        ),
        maxRetries: 0,
        allowSystemInMessages: true,
        maxOutputTokens: MAX_TOKENS,
      });
      await r.consumeStream();
      const messages = (await r.response).messages;
      const adapter = nvidiaAdapter(server.baseURL);
      const stored = adapter.toStored(
        { messages },
        {
          provider: "nvidia",
          package: "@ai-sdk/openai-compatible",
          packageVersion: "3.0.68",
          modelId: s.model,
        },
      );
      expect(stored.parts.length).toBeGreaterThan(0);
      expect(adapter.fromStored(stored, { provider: "nvidia", model: s.model })).toEqual(messages);
    });
  }

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
    const kinds = [400, 401, 402, 403, 404, 413, 429, 500, 503, 529].map((s) => {
      const e = adapter.classifyError(api(s));
      return [s, e.kind, e.retryable];
    });
    expect(kinds).toEqual([
      [400, "invalid_request", false],
      [401, "auth", false],
      [402, "billing", false],
      [403, "auth", false],
      [404, "not_found", false],
      [413, "too_large", false],
      [429, "rate_limit", true],
      [500, "server", true],
      [503, "overloaded", true],
      [529, "overloaded", true],
    ]);
  });

  test("a network failure is retryable; anything else is unknown", () => {
    expect(adapter.classifyError(new TypeError("fetch failed"))).toMatchObject({ kind: "network", retryable: true });
    expect(adapter.classifyError("weird")).toEqual({ kind: "unknown", retryable: false, message: "weird" });
  });
});
