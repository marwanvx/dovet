// Replays a recorded session through the adapter the way the agent loop would (providers "Acceptance criteria", SPIKE-44).
import {
  createSdkAdapter,
  endpointOf,
  type FetchFunction,
  type ProviderRequest,
  providerRecord,
  type RenderInput,
  type StreamEvent,
} from "../../src/ai/index.ts";
import type { StoredResponse } from "../../src/schema/index.ts";
import { Secret } from "../../src/store/index.ts";
import { startFixtureServer } from "./fixture-server.ts";
import { type Fixture, MAX_TOKENS, type Scenario } from "./nvidia-scenarios.ts";

export const FAKE_KEY = "test-key-not-real";

/** The real nvidia record pointed at `baseURL`; effort is sent only when the probe found the model reasoning. */
export function nvidiaAdapter(
  baseURL: string,
  opts: { reasons?: boolean; levels?: string[]; fetch?: FetchFunction } = {},
) {
  const nvidia = endpointOf(providerRecord("nvidia"));
  return createSdkAdapter({
    endpoint: () => ({ ...nvidia, baseURL, apiKey: new Secret(FAKE_KEY) }),
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    modelInfo: () => (opts.reasons === true ? { effortLevels: opts.levels ?? nvidia.effortLevels } : undefined),
  });
}

export function renderInput(s: Scenario, transcript: RenderInput["transcript"], effort = s.effort): RenderInput {
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
    params: { maxTokens: MAX_TOKENS, ...(effort === undefined ? {} : { effort }) },
    transcript,
    cache: { breakpoints: "auto", ttl: "auto" },
  };
}

export type Replay = {
  /** Request bodies the adapter sent, as captured by its fetch. */
  captured: ProviderRequest[];
  /** Request bodies the fixture server received. */
  received: string[];
  steps: Array<{ events: StreamEvent[]; stored: StoredResponse }>;
};

/** The scenario's turns (user, tool results, follow-up) against the fixture's recorded responses. */
export async function replaySession(s: Scenario, fx: Fixture): Promise<Replay> {
  const server = startFixtureServer(fx.exchanges);
  try {
    const adapter = nvidiaAdapter(server.baseURL, { reasons: fx.probe?.reasons === true });
    const captured: ProviderRequest[] = [];
    const steps: Replay["steps"] = [];
    const transcript: RenderInput["transcript"] = [{ kind: "user", parts: [{ kind: "text", text: s.user }] }];
    const step = async () => {
      const events: StreamEvent[] = [];
      const call = adapter.render(renderInput(s, transcript));
      for await (const e of adapter.stream(call, {
        signal: new AbortController().signal,
        onRequest: (r) => captured.push(r),
      }))
        events.push(e);
      const done = events.find((e) => e.type === "done");
      if (done?.type !== "done") throw new Error(`step ${steps.length + 1}: ${JSON.stringify(events.at(-1))}`);
      steps.push({ events, stored: done.stored });
      transcript.push({ kind: "assistant", stored: done.stored });
      return done.stored;
    };
    const first = await step();
    if (s.results !== undefined) {
      const results = s.results;
      const calls = first.parts.filter((p) => p.kind === "tool_call");
      if (calls.length === 0) throw new Error(`${s.name}: the recorded answer has no tool call to answer`);
      transcript.push({
        kind: "user",
        parts: calls.map((c, i) => {
          const r = results[i % results.length] ?? { output: "", isError: false };
          return { kind: "tool_result", callId: c.id, isError: r.isError, content: [{ kind: "text", text: r.output }] };
        }),
      });
      await step();
    }
    if (s.followUp !== undefined) {
      transcript.push({ kind: "user", parts: [{ kind: "text", text: s.followUp }] });
      await step();
    }
    return { captured, received: [...server.received], steps };
  } finally {
    await server.stop();
  }
}
