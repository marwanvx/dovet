import { afterEach, describe, expect, test } from "bun:test";
import { Secret } from "../../src/store/index.ts";
import { type Exchange, probeModel, sseBody, startFixtureServer } from "./index.ts";

const servers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const chunk = (delta: unknown, finish: string | null = null) => ({
  id: "c",
  object: "chat.completion.chunk",
  created: 1,
  model: "example/model",
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const reply = (status: number, body: string, contentType = "application/json"): Exchange => ({
  request: { path: "/v1/chat/completions", body: "" },
  response: { status, contentType, body },
});
const stream = (chunks: unknown[]) => reply(200, sseBody(chunks), "text/event-stream");
const toolCall = stream([
  chunk({
    tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } }],
  }),
  chunk({}, "tool_calls"),
]);

async function probe(exchanges: Exchange[]) {
  const server = startFixtureServer(exchanges);
  servers.push(server);
  const result = await probeModel("example/model", {
    baseURL: server.baseURL,
    apiKey: new Secret("test-key-not-real"),
  });
  return { result, received: server.received.map((b) => JSON.parse(b)) };
}

// spec: testing "Free test provider: NVIDIA" (probe before relying on a model; retired models and 429s are skipped)
describe("model probe", () => {
  test("a working reasoning model passes a chat and a tool-call request, sent with tool_choice auto", async () => {
    const { result, received } = await probe([
      stream([chunk({ reasoning_content: "The user wants ok." }), chunk({ content: "ok" }), chunk({}, "stop")]),
      toolCall,
    ]);
    expect(result).toMatchObject({ model: "example/model", ok: true, reasons: true });
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ tool_choice: "auto", tools: [{ function: { name: "echo" } }] });
  });

  test("a model that answers without reasoning is marked as not reasoning", async () => {
    const { result } = await probe([stream([chunk({ content: "ok" }), chunk({}, "stop")]), toolCall]);
    expect(result).toMatchObject({ ok: true, reasons: false });
  });

  test("a retired model (410 Gone, as NVIDIA answers) is skipped with the server's reason", async () => {
    const gone = JSON.stringify({
      status: 410,
      title: "Gone",
      detail:
        "The model 'example/model' has reached its end of life on 2026-05-12T00:00:00Z and is no longer available.",
    });
    const { result } = await probe([reply(410, gone)]);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.skipped).toMatch(/^retired or unknown model: HTTP 410: Gone: .*end of life/);
  });

  test("an unknown model (404) and a rate limit (429) are skipped, not failed", async () => {
    expect((await probe([reply(404, "404 page not found", "text/plain")])).result).toMatchObject({
      ok: false,
      skipped: expect.stringMatching(/^retired or unknown model/),
    });
    expect((await probe([reply(429, '{"error":{"message":"Too Many Requests"}}')])).result).toMatchObject({
      ok: false,
      skipped: expect.stringMatching(/^rate limited/),
    });
  });

  test("an outage is skipped; a model that makes no tool call is skipped", async () => {
    expect((await probe([reply(503, '{"error":{"message":"down"}}')])).result).toMatchObject({
      ok: false,
      skipped: expect.stringMatching(/^outage/),
    });
    const noCall = stream([chunk({ content: "I can't." }), chunk({}, "stop")]);
    expect((await probe([stream([chunk({ content: "ok" }), chunk({}, "stop")]), noCall])).result).toMatchObject({
      ok: false,
      skipped: "no tool call: the model answered in text",
    });
  });

  test("a rejected key is an error, not a skipped model", async () => {
    await expect(probe([reply(401, '{"error":{"message":"Unauthorized"}}')])).rejects.toThrow(/auth/);
  });
});
