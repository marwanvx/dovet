import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

type Chunk = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer C> ? C : never;

export type ScriptStep =
  | { text: string; reasoning?: string }
  | { toolCall: { id: string; name: string; input: unknown } }
  | { toolCalls: Array<{ id: string; name: string; input: unknown }> }
  | { error: Error };

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

/** A model that answers each request with the next scripted step, through the real AI SDK stream protocol. */
export function scriptedModel(steps: ScriptStep[]): MockLanguageModelV4 {
  let next = 0;
  return new MockLanguageModelV4({
    doStream: () => {
      const step = steps[next];
      next += 1;
      if (!step) return Promise.reject(new Error(`scriptedModel: script exhausted at request ${next}`));
      if ("error" in step) return Promise.reject(step.error);
      const chunks: Chunk[] = [];
      if ("text" in step) {
        if (step.reasoning !== undefined) {
          chunks.push(
            { type: "reasoning-start" as const, id: "r1" },
            { type: "reasoning-delta" as const, id: "r1", delta: step.reasoning },
            { type: "reasoning-end" as const, id: "r1" },
          );
        }
        chunks.push(
          { type: "text-start" as const, id: "t1" },
          { type: "text-delta" as const, id: "t1", delta: step.text },
          { type: "text-end" as const, id: "t1" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE },
        );
      } else {
        for (const tc of "toolCalls" in step ? step.toolCalls : [step.toolCall])
          chunks.push({
            type: "tool-call" as const,
            toolCallId: tc.id,
            toolName: tc.name,
            input: JSON.stringify(tc.input),
          });
        chunks.push({
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USAGE,
        });
      }
      return Promise.resolve({
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      });
    },
  });
}
