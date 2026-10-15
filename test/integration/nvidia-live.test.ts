// Live NVIDIA smoke tests for nightly CI (testing "Test layers" and "Free test provider: NVIDIA").
// Every PR runs the workflow shape and the pure normalization checks; only nightly has the key,
// so the live turns log `live nvidia: skipped: <reason>` and pass when the key or a model is missing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildEpoch, buildRequest } from "../../src/agent/transcript/index.ts";
import {
  createSdkAdapter,
  endpointOf,
  type ProviderRequest,
  providerRecord,
  sortTools,
  type ToolDef,
} from "../../src/ai/index.ts";
import type { EventEnvelope, StoredResponse } from "../../src/schema/index.ts";
import { isHistoryRelated, Secret } from "../../src/store/index.ts";
import { NVIDIA_MODELS, probeModel } from "../helpers/index.ts";

const ECHO: ToolDef = {
  name: "echo",
  description: "Echo the given text back.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};
const READ: ToolDef = {
  name: "read",
  description: "Read a text file and return its contents.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};
const SYSTEM =
  "You are a terse test assistant. Follow the instruction exactly. When asked to call a tool, call it with the given arguments and nothing else.";
const INSTRUCTION = "Prefer terse replies from here on.";
const INSTRUCTION_PREFIX = "[Dovet instruction] ";

let counter = 0;
function ev(type: string, data: unknown, turn: number | null): EventEnvelope {
  counter += 1;
  return {
    v: 1,
    id: String(counter).padStart(26, "0"),
    ts: "2026-10-15T00:00:00.000Z",
    session: "00000000000000000000000000",
    epoch: 0,
    turn,
    type,
    core: true,
    data,
  };
}

/** Request `b` extends `a`: same bytes except a longer message list (contract "prefix property"). */
function extendsRequest(a: string, b: string): boolean {
  const pa = JSON.parse(a) as { messages: unknown[] };
  const pb = JSON.parse(b) as { messages: unknown[] };
  if (pb.messages.length <= pa.messages.length) return false;
  return JSON.stringify({ ...pb, messages: pb.messages.slice(0, pa.messages.length) }) === a;
}

function skipped(reason: string): void {
  console.log(`live nvidia: skipped: ${reason}`);
}

async function selectModel(key: string): Promise<{ model: string; reasons: boolean } | { skipped: string }> {
  const baseURL = endpointOf(providerRecord("nvidia")).baseURL;
  const failures: string[] = [];
  for (const model of NVIDIA_MODELS) {
    const probe = await probeModel(model, { baseURL, apiKey: new Secret(key) });
    if (probe.ok) return { model, reasons: probe.reasons };
    failures.push(`${model}: ${probe.skipped}`);
  }
  return { skipped: `no probed model answered (${failures.join("; ")})` };
}

describe("nightly workflow", () => {
  test("nightly.yml runs the live smoke tests on a schedule, never on PRs", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "nightly.yml"), "utf8");
    expect(text).toContain("schedule");
    expect(text).toContain("cron");
    expect(text).toContain("workflow_dispatch");
    expect(text).toContain("NVIDIA_API_KEY");
    expect(text).toContain("nvidia-live");
    expect(text).toContain("contents: read");
    expect(text).not.toContain("pull_request");
  });
});

describe("live nvidia smoke", () => {
  test("10-turn tool-using session with a mid-epoch instruction", async () => {
    const key = process.env.NVIDIA_API_KEY;
    if (key === undefined || key === "") {
      skipped("NVIDIA_API_KEY is not set");
      return;
    }
    const picked = await selectModel(key);
    if ("skipped" in picked) {
      skipped(picked.skipped);
      return;
    }
    counter = 0;
    const baseURL = endpointOf(providerRecord("nvidia")).baseURL;
    const adapter = createSdkAdapter({
      endpoint: () => ({ ...endpointOf(providerRecord("nvidia")), baseURL, apiKey: new Secret(key) }),
    });
    const epoch: BuildEpoch = {
      header: {
        epoch: 0,
        provider: "nvidia",
        model: picked.model,
        promptVersion: "live",
        systemText: SYSTEM,
        toolsJson: JSON.stringify(sortTools([ECHO, READ])),
        thinking: { mode: "off" },
      },
      params: { maxTokens: 512 },
      cache: { breakpoints: "auto", ttl: "auto" },
    };
    const events: EventEnvelope[] = [];
    const bodies: string[] = [];
    const seenHeaders: Array<ProviderRequest["headers"]> = [];
    let toolCallTurns = 0;
    let textDeltas = 0;

    for (let turn = 1; turn <= 10; turn++) {
      if (turn === 6)
        events.push(
          ev("system.injected", { text: INSTRUCTION, reason: "queued-messages", delivery: "reminder-block" }, turn),
        );
      const prompt =
        turn === 10
          ? "Final turn: reply in plain text with one short paragraph about testing, no tool calls."
          : `Turn ${turn} of 10: Call the echo tool with text "turn-${turn}".`;
      events.push(ev("user.message", { text: prompt }, turn));
      const call = adapter.render(buildRequest(events, epoch));
      let stored: StoredResponse | undefined;
      for await (const e of adapter.stream(call, {
        signal: AbortSignal.timeout(180_000),
        onRequest: (r) => {
          bodies.push(r.body);
          seenHeaders.push(r.headers);
        },
      })) {
        if (e.type === "text.delta") textDeltas += 1;
        if (e.type === "done") stored = e.stored;
        if (e.type === "aborted") {
          skipped("no answer within 3 minutes");
          return;
        }
        if (e.type === "error") {
          const retriable = ["rate_limit", "overloaded", "server", "network", "timeout"].includes(e.error.kind);
          const gone = e.error.kind === "not_found" || /function .*not found|ResourceExhausted/i.test(e.error.message);
          if (retriable || gone) {
            skipped(`${e.error.kind}: ${e.error.message}`.slice(0, 200));
            return;
          }
          throw new Error(`live turn ${turn}: ${e.error.kind}: ${e.error.message}`.slice(0, 300));
        }
      }
      if (stored === undefined) throw new Error(`live turn ${turn}: the stream ended without a result`);
      events.push(ev("model.response", stored, turn));
      const calls = stored.parts.filter((p) => p.kind === "tool_call");
      if (calls.length > 0) toolCallTurns += 1;
      for (const c of calls) {
        if (c.kind !== "tool_call") continue;
        const isEchoError = turn === 3;
        events.push(
          ev(
            "tool.result",
            isEchoError
              ? { callId: c.id, status: "error", output: "error: demo failure for turn-3" }
              : { callId: c.id, status: "ok", output: `ok ${c.name}` },
            turn,
          ),
        );
      }
    }

    expect(bodies).toHaveLength(10);
    expect(toolCallTurns).toBeGreaterThanOrEqual(8);
    expect(textDeltas).toBeGreaterThan(0);
    for (let i = 1; i < bodies.length; i++) {
      expect(extendsRequest(bodies[i - 1] ?? "", bodies[i] ?? "")).toBe(true);
    }
    expect(bodies[5] ?? "").toContain(`${INSTRUCTION_PREFIX}${INSTRUCTION}`);
    const leaked = bodies.some((b) => b.includes(key));
    expect(leaked).toBe(false);
    const headerLeaked = seenHeaders.some((h) => JSON.stringify(h).includes(key));
    expect(headerLeaked).toBe(false);
  }, 600_000);

  test("replay normalization on a crafted history is accepted live", async () => {
    counter = 100_000;
    const crafted: EventEnvelope[] = [
      ev("user.message", { text: "go" }, 1),
      ev(
        "model.response",
        {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "@ai-sdk/openai-compatible",
          packageVersion: "pinned",
          modelId: "example/model",
          parts: [
            { kind: "text", text: "" },
            { kind: "text", text: "  \n" },
          ],
          usage: {},
          finishReason: "stop",
        },
        1,
      ),
      ev(
        "model.response",
        {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "@ai-sdk/openai-compatible",
          packageVersion: "pinned",
          modelId: "example/model",
          parts: [{ kind: "text", text: "real" }],
          usage: {},
          finishReason: "stop",
        },
        1,
      ),
      ev(
        "model.response",
        {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "@ai-sdk/openai-compatible",
          packageVersion: "pinned",
          modelId: "example/model",
          parts: [
            { kind: "tool_call", id: "a", name: "read", inputJson: "{}" },
            { kind: "tool_call", id: "b", name: "read", inputJson: "{}" },
          ],
          usage: {},
          finishReason: "tool_calls",
        },
        1,
      ),
      ev("tool.result", { callId: "b", status: "ok", output: "second" }, 1),
      ev("tool.result", { callId: "a", status: "ok", output: "first" }, 1),
      ev("system.injected", { text: INSTRUCTION, reason: "queued-messages", delivery: "reminder-block" }, 1),
    ];
    const epoch: BuildEpoch = {
      header: {
        epoch: 0,
        provider: "nvidia",
        model: "example/model",
        promptVersion: "live",
        systemText: SYSTEM,
        toolsJson: JSON.stringify(sortTools([ECHO, READ])),
        thinking: { mode: "off" },
      },
      params: { maxTokens: 512 },
      cache: { breakpoints: "auto", ttl: "auto" },
    };
    const first = buildRequest(crafted, epoch);
    const second = buildRequest([...crafted], epoch);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const assistant = first.transcript.filter((t) => t.kind === "assistant");
    expect(assistant).toHaveLength(2);
    const order = first.transcript.at(-1);
    if (order?.kind !== "user") throw new Error("the crafted group must end in a user item");
    expect(
      order.parts.filter((p) => p.kind === "tool_result").map((p) => (p.kind === "tool_result" ? p.callId : "")),
    ).toEqual(["a", "b"]);

    const key = process.env.NVIDIA_API_KEY;
    if (key === undefined || key === "") {
      skipped("NVIDIA_API_KEY is not set");
      return;
    }
    const picked = await selectModel(key);
    if ("skipped" in picked) {
      skipped(picked.skipped);
      return;
    }
    const baseURL = endpointOf(providerRecord("nvidia")).baseURL;
    const adapter = createSdkAdapter({
      endpoint: () => ({ ...endpointOf(providerRecord("nvidia")), baseURL, apiKey: new Secret(key) }),
    });
    const liveEpoch: BuildEpoch = { ...epoch, header: { ...epoch.header, model: picked.model } };
    const call = adapter.render(buildRequest(crafted, liveEpoch));
    for await (const e of adapter.stream(call, {
      signal: AbortSignal.timeout(180_000),
      onRequest: () => {},
    })) {
      if (e.type === "aborted") {
        skipped("no answer within 3 minutes");
        return;
      }
      if (e.type === "error") {
        if (isHistoryRelated(e.error))
          throw new Error(`live rejected the normalized history: ${e.error.message}`.slice(0, 300));
        const skipKinds = ["rate_limit", "overloaded", "server", "network", "timeout", "not_found"];
        if (skipKinds.includes(e.error.kind) || /function .*not found|ResourceExhausted/i.test(e.error.message)) {
          skipped(`${e.error.kind}: ${e.error.message}`.slice(0, 200));
          return;
        }
        throw new Error(`live crafted history: ${e.error.kind}: ${e.error.message}`.slice(0, 300));
      }
      if (e.type === "done") {
        expect(e.stored.parts.length).toBeGreaterThan(0);
        return;
      }
    }
    throw new Error("the crafted-history stream ended without a result");
  }, 600_000);
});
