// The adapter contract per bundled provider package (providers §1 and "Acceptance criteria", SPIKE-44).
// Each package added later gets an entry in CASES and must pass the same tests (QUESTIONS Q26).
import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, type ModelMessage, streamText, tool } from "ai";
import {
  FAKE_KEY,
  type Fixture,
  fakeClock,
  MAX_TOKENS,
  nvidiaAdapter,
  renderInput,
  replaySession,
  SCENARIOS,
  type Scenario,
  sequentialIds,
  startFixtureServer,
  tempProject,
} from "../../test/helpers/index.ts";
import type { Os } from "../platform/index.ts";
import { StoredResponse } from "../schema/index.ts";
import { openSession, readSession } from "../store/index.ts";
import type { ProviderRequest, RenderInput } from "./index.ts";

const servers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const CASES = [
  {
    package: "@ai-sdk/openai-compatible",
    fixtureDir: "nvidia",
    scenarios: ["text", "parallel-tools", "session"],
    direct: (baseURL: string, model: string) =>
      createOpenAICompatible({ name: "nvidia", baseURL, apiKey: "x", includeUsage: true }).chatModel(model),
  },
];

function scenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  return s;
}

/** Request `b` extends `a`: every field but the message list is byte-equal, and `a`'s messages begin `b`'s. */
function extendsRequest(a: string, b: string): boolean {
  const pa = JSON.parse(a) as { messages: unknown[] };
  const pb = JSON.parse(b) as { messages: unknown[] };
  if (JSON.stringify(pa) !== a || JSON.stringify(pb) !== b) return false;
  if (pb.messages.length <= pa.messages.length) return false;
  return JSON.stringify({ ...pb, messages: pb.messages.slice(0, pa.messages.length) }) === a;
}

const SDK_MESSAGE_KEYS = new Set(["role", "providerOptions", "providerMetadata", "toolCallId", "toolName"]);
function sdkKeysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(sdkKeysIn);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [...(SDK_MESSAGE_KEYS.has(k) ? [k] : []), ...sdkKeysIn(v)]);
}

for (const c of CASES) {
  const fixture = async (name: string): Promise<Fixture> =>
    (await Bun.file(`${import.meta.dir}/../../test/fixtures/${c.fixtureDir}/${name}.json`).json()) as Fixture;

  describe(`contract: ${c.package}`, () => {
    for (const name of c.scenarios) {
      // spec: AC-PROV-01
      // spec: AC-PROV-18
      test(`${name}: every request on replay equals the recorded direct-SDK request byte for byte`, async () => {
        const fx = await fixture(name);
        const r = await replaySession(scenario(name), fx);
        expect(r.received).toEqual(fx.exchanges.map((x) => x.request.body));
        expect(r.captured.map((x: ProviderRequest) => x.body)).toEqual(r.received);
        for (const x of r.captured) {
          expect(x.bodySha256).toBe(new Bun.CryptoHasher("sha256").update(x.body).digest("hex"));
          expect(JSON.stringify(x.headers)).not.toContain(FAKE_KEY);
        }
      });

      // spec: AC-PROV-02
      test(`${name}: each request extends the one before it`, async () => {
        const bodies = (await fixture(name)).exchanges.map((x) => x.request.body);
        for (let i = 1; i < bodies.length; i++) expect(extendsRequest(bodies[i - 1] ?? "", bodies[i] ?? "")).toBe(true);
      });

      // spec: AC-PROV-18
      test(`${name}: every recorded response survives SDK messages → stored parts → SDK messages`, async () => {
        const fx = await fixture(name);
        const s = scenario(name);
        const adapter = nvidiaAdapter("http://unused");
        for (const exchange of fx.exchanges) {
          const server = startFixtureServer([exchange]);
          servers.push(server);
          const r = streamText({
            model: c.direct(server.baseURL, s.model),
            messages: [
              { role: "system", content: s.systemText },
              { role: "user", content: [{ type: "text", text: s.user }] },
            ],
            tools: Object.fromEntries(
              s.tools.map((d) => [
                d.name,
                tool({ description: d.description, inputSchema: jsonSchema(d.inputSchema) }),
              ]),
            ),
            maxRetries: 0,
            allowSystemInMessages: true,
            maxOutputTokens: MAX_TOKENS,
          });
          await r.consumeStream();
          const messages = (await r.response).messages.filter((m: ModelMessage) => m.role === "assistant");
          const ctx = { provider: "nvidia", package: c.package, packageVersion: "pinned", modelId: s.model };
          const stored = adapter.toStored({ messages }, ctx);
          expect(stored.parts.length).toBeGreaterThan(0);
          expect(adapter.fromStored(stored, { provider: "nvidia", model: s.model })).toEqual(messages);
        }
      });
    }

    // spec: AC-PROV-02
    test("over 30 turns of one epoch, each request extends the one before it", async () => {
      const s = scenario("session");
      const server = startFixtureServer(
        Array.from({ length: 30 }, () => ({
          request: { path: "", body: "" },
          response: { status: 400, contentType: "application/json", body: '{"error":{"message":"stop"}}' },
        })),
      );
      servers.push(server);
      const adapter = nvidiaAdapter(server.baseURL, { reasons: true });
      const replay = { provider: "nvidia", protocol: "openai-chat" as const, modelId: s.model, fields: {} };
      const transcript: RenderInput["transcript"] = [];
      const bodies: string[] = [];
      for (let turn = 0; turn < 30; turn++) {
        if (turn % 3 === 0) transcript.push({ kind: "user", parts: [{ kind: "text", text: `task ${turn}` }] });
        else if (turn % 3 === 1) {
          transcript.push({
            kind: "assistant",
            stored: {
              provider: "nvidia",
              protocol: "openai-chat",
              package: c.package,
              packageVersion: "pinned",
              modelId: s.model,
              parts: [
                { kind: "reasoning", summary: `thinking ${turn}`, replay },
                { kind: "tool_call", id: `call-${turn}`, name: "read", inputJson: `{"path":"f${turn}"}` },
              ],
              usage: {},
              finishReason: "tool_calls",
            },
          });
          transcript.push({
            kind: "user",
            parts: [
              {
                kind: "tool_result",
                callId: `call-${turn}`,
                isError: turn % 2 === 0,
                content: [{ kind: "text", text: "x" }],
              },
            ],
          });
        } else {
          transcript.push({
            kind: "assistant",
            stored: {
              provider: "nvidia",
              protocol: "openai-chat",
              package: c.package,
              packageVersion: "pinned",
              modelId: s.model,
              parts: [{ kind: "text", text: `done ${turn}` }],
              usage: {},
              finishReason: "stop",
            },
          });
        }
        const call = adapter.render(renderInput(s, transcript));
        for await (const _ of adapter.stream(call, {
          signal: new AbortController().signal,
          onRequest: (r) => bodies.push(r.body),
        }));
      }
      expect(bodies).toHaveLength(30);
      for (let i = 1; i < bodies.length; i++) expect(extendsRequest(bodies[i - 1] ?? "", bodies[i] ?? "")).toBe(true);
    });

    // spec: AC-PROV-18
    test("the event log holds Dovet's stored responses, never AI SDK message objects", async () => {
      const r = await replaySession(scenario("session"), await fixture("session"));
      const project = await tempProject();
      try {
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
        for (const step of r.steps)
          opened.writer.append({ type: "model.response", epoch: 0, turn: 1, data: step.stored });
        await opened.writer.close();
        const read = await readSession(loc);
        expect(read.readOnly).toBeUndefined();
        const data = read.events.filter((e) => e.type === "model.response").map((e) => e.data);
        expect(data).toEqual(r.steps.map((s) => s.stored));
        for (const d of data) {
          expect(StoredResponse.parse(d)).toEqual(d as StoredResponse);
          expect(sdkKeysIn(d)).toEqual([]);
        }
      } finally {
        await project.dispose();
      }
    });
  });
}
