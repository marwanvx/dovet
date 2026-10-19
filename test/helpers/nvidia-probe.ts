// The model probe (testing "Free test provider: NVIDIA"): a chat and a tool call before a model is relied on.
import {
  createSdkAdapter,
  endpointOf,
  type ProviderErrorInfo,
  providerRecord,
  type ToolDef,
} from "../../src/ai/index.ts";
import type { StoredResponse } from "../../src/schema/index.ts";
import type { Secret } from "../../src/store/index.ts";

export type Probe =
  | { model: string; date: string; ok: true; reasons: boolean }
  | { model: string; ok: false; skipped: string };

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

/** Why a failure is the model's or the service's and not Dovet's, or undefined when it is not. */
function skipReason(e: ProviderErrorInfo): string | undefined {
  const what = `${e.status === undefined ? e.kind : `HTTP ${e.status}`}: ${e.message}`;
  if (e.kind === "not_found" || /function .*not found/i.test(e.message)) return `retired or unknown model: ${what}`;
  // NVIDIA also reports a full worker inside a 200 stream: "ResourceExhausted: Worker local total request limit reached".
  if (e.kind === "rate_limit" || /ResourceExhausted/.test(e.message)) return `rate limited: ${what}`;
  if (["overloaded", "server", "network", "timeout"].includes(e.kind)) return `outage: ${what}`;
  return undefined;
}

export async function probeModel(
  model: string,
  opts: { baseURL: string; apiKey: Secret; timeoutMs?: number | undefined },
): Promise<Probe> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const adapter = createSdkAdapter({
    endpoint: () => ({ ...endpointOf(providerRecord("nvidia")), baseURL: opts.baseURL, apiKey: opts.apiKey }),
  });
  const ask = async (text: string, tools: ToolDef[]): Promise<StoredResponse | { skipped: string }> => {
    const call = adapter.render({
      header: {
        epoch: 0,
        provider: "nvidia",
        model,
        promptVersion: "probe",
        systemText: "You are a test probe. Follow the instruction exactly.",
        toolsJson: JSON.stringify(tools),
        thinking: { mode: "off" },
      },
      params: { maxTokens: 2048 },
      transcript: [{ kind: "user", parts: [{ kind: "text", text }] }],
      cache: { breakpoints: "auto", ttl: "auto" },
    });
    for await (const e of adapter.stream(call, { signal: AbortSignal.timeout(timeoutMs), onRequest: () => {} })) {
      if (e.type === "done") return e.stored;
      if (e.type === "error") {
        const skipped = skipReason(e.error);
        if (skipped === undefined) throw new Error(`probe of ${model}: ${e.error.kind}: ${e.error.message}`);
        return { skipped };
      }
      if (e.type === "aborted") {
        const durationDesc =
          timeoutMs >= 60_000 && timeoutMs % 60_000 === 0
            ? `${timeoutMs / 60_000} minute${timeoutMs === 60_000 ? "" : "s"}`
            : `${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} seconds`}`;
        return { skipped: `outage: no answer within ${durationDesc}` };
      }
    }
    throw new Error(`probe of ${model}: the stream ended without a result`);
  };

  const chat = await ask("Reply with the single word: ok", []);
  if ("skipped" in chat) return { model, ok: false, ...chat };
  const tool = await ask('Call the echo tool with text "hi".', [ECHO]);
  if ("skipped" in tool) return { model, ok: false, ...tool };
  if (!tool.parts.some((p) => p.kind === "tool_call" && p.name === "echo"))
    return { model, ok: false, skipped: "no tool call: the model answered in text" };
  const reasons = chat.parts.some((p) => p.kind === "reasoning" && (p.summary ?? "") !== "");
  return { model, date: new Date().toISOString().slice(0, 10), ok: true, reasons };
}
