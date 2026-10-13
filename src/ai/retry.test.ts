import { afterEach, describe, expect, test } from "bun:test";
import { nvidiaAdapter, type Scripted, type Step, startScriptedServer } from "../../test/helpers/index.ts";

import type { RenderInput } from "./index.ts";
import { type CallEvent, callModel, STREAM_IDLE_TIMEOUT_MS, timedFetch } from "./index.ts";

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 1,
  model: "example-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const frame = (o: unknown): Step => ({ send: `data: ${JSON.stringify(o)}\n\n` });
const done: Step = { send: "data: [DONE]\n\n" };
// Bun's fetch discards bytes that arrive in the same packet as a reset, so a drop after output waits for them to land.
const dropLater: Step[] = [{ wait: 50 }, "drop"];
const answer = (text: string): Scripted => ({
  steps: [frame(chunk({ role: "assistant", content: text })), frame(chunk({}, "stop")), done],
});
const jsonError = (status: number, body: unknown, headers: Record<string, string> = {}): Scripted => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  steps: [{ send: JSON.stringify(body) }],
});
const overloaded = jsonError(
  529,
  { error: { message: "Overloaded", type: "overloaded_error" } },
  {
    "x-request-id": "req-529",
  },
);
const readCall = (args: string) =>
  frame(
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: args } }] }),
  );

const input: RenderInput = {
  header: {
    epoch: 0,
    provider: "nvidia",
    model: "example-model",
    promptVersion: "test",
    systemText: "You are a test.",
    toolsJson: JSON.stringify([
      {
        name: "Read",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]),
    thinking: { mode: "off" },
  },
  params: { maxTokens: 100 },
  transcript: [{ kind: "user", parts: [{ kind: "text", text: "Read a.txt" }] }],
  cache: { breakpoints: "auto", ttl: "auto" },
};

const servers: Array<() => void> = [];
afterEach(() => {
  for (const stop of servers.splice(0)) stop();
});

async function run(responses: Scripted[], opts: { idleMs?: number } = {}) {
  const server = startScriptedServer(responses);
  servers.push(server.stop);
  const slept: number[] = [];
  const base = nvidiaAdapter(server.baseURL);
  const adapter =
    opts.idleMs === undefined
      ? base
      : nvidiaAdapter(server.baseURL, { fetch: timedFetch(fetch, { idleMs: opts.idleMs }) });
  const events: CallEvent[] = [];
  const deps = {
    adapter,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    random: () => 0.5,
  };
  for await (const e of callModel(input, deps, { signal: new AbortController().signal })) events.push(e);
  const of = <T extends CallEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<CallEvent, { type: T }> => e.type === type);
  return { events, of, slept, received: server.received };
}

const bodyMessages = (body: string | undefined): unknown[] =>
  (JSON.parse(body ?? "{}") as { messages: unknown[] }).messages;

describe("retry policy", () => {
  // spec: AC-PROV-09
  test("a 529 then success: one retry status, two requests, one error, the right answer", async () => {
    const r = await run([overloaded, answer("Hello")]);
    expect(r.of("request")).toHaveLength(2);
    const errors = r.of("attempt.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ attempt: 1, willRetry: true, error: { kind: "overloaded", status: 529 } });
    const statuses = r.of("retrying");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.detail).toMatch(/^Retrying \(2\/6\) in \ds — overloaded \(529\), request id req-529$/);
    const final = r.events.at(-1);
    expect(final?.type).toBe("done");
    if (final?.type === "done") expect(final.stored.parts).toEqual([{ kind: "text", text: "Hello" }]);
  });

  // spec: AC-PROV-11
  test("an in-stream overloaded_error after partial text discards the text and the retry succeeds", async () => {
    const r = await run([
      {
        steps: [
          frame(chunk({ role: "assistant", content: "Partial answ" })),
          frame({ error: { message: "Overloaded", type: "overloaded_error" } }),
        ],
      },
      answer("Whole answer"),
    ]);
    expect(r.of("attempt.error")[0]).toMatchObject({ willRetry: true, error: { kind: "overloaded", retryable: true } });
    expect(r.of("discarded")).toHaveLength(1);
    expect(r.of("kept")).toHaveLength(0);
    expect(r.received[1]).toBe(r.received[0]);
    const final = r.events.at(-1);
    if (final?.type !== "done") throw new Error(`expected done, got ${final?.type}`);
    expect(final.stored.parts).toEqual([{ kind: "text", text: "Whole answer" }]);
  });

  // spec: AC-PROV-14
  test("stream drops, 529s and damaged streams share one budget of 6 requests", async () => {
    const drop: Scripted = { steps: ["drop"] };
    const damaged: Scripted = {
      steps: [frame(chunk({ role: "assistant", content: "Hi" })), { send: "data: {not json\n\n" }],
    };
    const r = await run([drop, drop, overloaded, overloaded, damaged, damaged, answer("never sent")]);
    expect(r.received).toHaveLength(6);
    expect(r.of("request")).toHaveLength(6);
    const errors = r.of("attempt.error");
    expect(errors.map((e) => e.willRetry)).toEqual([true, true, true, true, true, false]);
    expect(errors.map((e) => e.error.kind)).toEqual([
      "network",
      "network",
      "overloaded",
      "overloaded",
      "server",
      "server",
    ]);
    for (const e of errors) expect(e.error.message).not.toMatch(/JSON Parse|undefined|Failed to process/);
    expect(r.of("retrying").map((s) => s.detail.slice(0, 15))).toEqual([
      "Retrying (2/6) ",
      "Retrying (3/6) ",
      "Retrying (4/6) ",
      "Retrying (5/6) ",
      "Retrying (6/6) ",
    ]);
    expect(r.events.at(-1)).toMatchObject({ type: "failed", error: { kind: "server" } });
    // full jitter at random() = 0.5: half of 2, 4, 8, 16, 32 s, never under 1 s
    expect(r.slept).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  // spec: AC-PROV-14
  test("Retry-After: 0 still waits at least 1 s; a longer Retry-After is honored", async () => {
    const limited = (after: string) =>
      jsonError(429, { error: { message: "Too many requests", type: "rate_limit_error" } }, { "retry-after": after });
    const r = await run([limited("0"), limited("7"), answer("ok")]);
    expect(r.slept).toEqual([1000, 7000]);
    expect(r.events.at(-1)?.type).toBe("done");
  });

  // spec: AC-PROV-14
  test("a proxy's HTML 502 page is reported by status, proxy and title, never as markup", async () => {
    const page: Scripted = {
      status: 502,
      headers: { "content-type": "text/html", server: "nginx" },
      steps: [{ send: "<html><head><title>502 Bad Gateway</title></head><body><h1>Bad</h1></body></html>" }],
    };
    const r = await run([page, answer("ok")]);
    const error = r.of("attempt.error")[0]?.error;
    expect(error).toMatchObject({ kind: "server", status: 502, retryable: true });
    expect(error?.message).toBe("HTTP 502 from nginx: 502 Bad Gateway");
    expect(r.of("retrying")[0]?.detail).toMatch(/— server error \(502\)$/);
  });

  test("429 insufficient quota is fatal: no retry", async () => {
    const r = await run([
      jsonError(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota" } }),
      answer("never"),
    ]);
    expect(r.received).toHaveLength(1);
    expect(r.events.at(-1)).toMatchObject({ type: "failed", error: { kind: "quota", retryable: false } });
  });

  // spec: AC-PROV-15
  test("a drop after a complete text block and tool call keeps both and continues the turn", async () => {
    const r = await run([
      {
        steps: [
          frame(chunk({ role: "assistant", content: "I'll read it." })),
          readCall('{"path":"a.txt"}'),
          ...dropLater,
        ],
      },
      answer("Continuing."),
    ]);
    const kept = r.of("kept");
    expect(kept).toHaveLength(1);
    const [assistant, user] = kept[0]?.items ?? [];
    if (assistant?.kind !== "assistant") throw new Error("expected the kept assistant turn first");
    expect(assistant.stored.parts).toEqual([
      { kind: "text", text: "I'll read it." },
      { kind: "tool_call", id: "call_1", name: "Read", inputJson: '{"path":"a.txt"}' },
    ]);
    expect(user).toEqual({
      kind: "user",
      parts: [
        {
          kind: "tool_result",
          callId: "call_1",
          isError: true,
          content: [
            {
              kind: "text",
              text: "Not run: the connection dropped before your response finished. Re-issue the call if it is still needed.",
            },
          ],
        },
        {
          kind: "instruction",
          reason: "continue-after-drop",
          text: "Your previous response was cut off by a connection error after the blocks above. Continue from there.",
        },
      ],
    });
    expect(bodyMessages(r.received[1]).slice(2)).toEqual([
      {
        role: "assistant",
        content: "I'll read it.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: expect.stringContaining("Not run: the connection dropped") },
      {
        role: "user",
        content:
          "Your previous response was cut off by a connection error after the blocks above. Continue from there.",
      },
    ]);
    expect(r.events.at(-1)?.type).toBe("done");
  });

  // spec: AC-PROV-15
  test("a thinking-only drop is retried from scratch", async () => {
    const r = await run([
      { steps: [frame(chunk({ role: "assistant", reasoning_content: "Let me think" })), ...dropLater] },
      answer("Answer."),
    ]);
    expect(r.of("kept")).toHaveLength(0);
    expect(r.of("discarded")).toHaveLength(1);
    expect(r.received[1]).toBe(r.received[0]);
    expect(r.events.at(-1)?.type).toBe("done");
  });

  // spec: AC-PROV-15
  test("a stream that ends without its final event keeps no half-written block", async () => {
    const cut = await run([{ steps: [frame(chunk({ role: "assistant", content: "Half a sent" }))] }, answer("Full.")]);
    expect(cut.of("attempt.error")[0]?.error.message).toBe("The response stream ended before its final event.");
    expect(cut.of("kept")).toHaveLength(0);
    expect(cut.received[1]).toBe(cut.received[0]);

    const r = await run([
      { steps: [frame(chunk({ role: "assistant", content: "Reading." })), readCall('{"path":')] },
      answer("Full."),
    ]);
    const [assistant] = r.of("kept")[0]?.items ?? [];
    if (assistant?.kind !== "assistant") throw new Error("expected the text before the cut-off call to be kept");
    expect(assistant.stored.parts).toEqual([{ kind: "text", text: "Reading." }]);
    expect(bodyMessages(r.received[1]).slice(2)).toEqual([
      { role: "assistant", content: "Reading." },
      {
        role: "user",
        content:
          "Your previous response was cut off by a connection error after the blocks above. Continue from there.",
      },
    ]);
  });
});

describe("stream liveness", () => {
  test("the default idle timeout is 180 s", () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(180_000);
  });

  // spec: AC-LOOP-08
  test("a silent stream is aborted after the idle timeout and retried", async () => {
    const r = await run(
      [
        { steps: [frame(chunk({ role: "assistant", content: "" })), { wait: 2000 }, frame(chunk({}, "stop"))] },
        answer("Back."),
      ],
      { idleMs: 300 },
    );
    expect(r.of("attempt.error")[0]).toMatchObject({ willRetry: true, error: { kind: "timeout", retryable: true } });
    expect(r.events.at(-1)?.type).toBe("done");
  });

  // spec: AC-LOOP-08
  test("a response that never starts is aborted after the idle timeout and retried", async () => {
    const r = await run([{ delay: 2000, steps: [] }, answer("Started.")], { idleMs: 300 });
    expect(r.of("attempt.error")[0]?.error.kind).toBe("timeout");
    expect(r.events.at(-1)?.type).toBe("done");
  });

  // spec: AC-LOOP-08
  test("keep-alive comments keep a long, quiet stream alive", async () => {
    const ping: Step[] = [{ send: ": ping\n\n" }, { wait: 150 }];
    const r = await run(
      [
        {
          steps: [
            frame(chunk({ role: "assistant", reasoning_content: "thinking" })),
            ...ping,
            ...ping,
            ...ping,
            ...ping,
            frame(chunk({ content: "Done." })),
            frame(chunk({}, "stop")),
            done,
          ],
        },
      ],
      { idleMs: 300 },
    );
    expect(r.of("attempt.error")).toHaveLength(0);
    expect(r.received).toHaveLength(1);
    expect(r.events.at(-1)?.type).toBe("done");
  });
});
