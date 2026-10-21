// The reduced copy a summary request uses when the full transcript would not fit (context §6 procedure 3b).
import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "../../ai/index.ts";
import type { StoredResponse } from "../../schema/index.ts";
import { estimateContext } from "./estimate.ts";
import { reduceForSummary } from "./reduce.ts";

const stored = (parts: StoredResponse["parts"]): StoredResponse => ({
  provider: "example",
  protocol: "openai-chat",
  package: "x",
  packageVersion: "1",
  modelId: "m",
  parts,
  usage: {},
  finishReason: "stop",
});
const image = { kind: "image", blob: { store: "blob", id: "ab".repeat(32) }, mediaType: "image/png" } as const;
const text = (t: string) => ({ kind: "text", text: t }) as const;

/** Turn i: the model calls Read, the result is `size` characters. */
function round(
  i: number,
  size: number,
  extra: TranscriptItem["kind"] extends never ? never : unknown[] = [],
): TranscriptItem[] {
  return [
    { kind: "assistant", stored: stored([{ kind: "tool_call", id: `c${i}`, name: "Read", inputJson: "{}" }]) },
    {
      kind: "user",
      parts: [
        {
          kind: "tool_result",
          callId: `c${i}`,
          isError: false,
          content: [text("r".repeat(size)), ...(extra as never[])],
        },
      ],
    },
  ];
}
const sizeOf = (items: TranscriptItem[]): number =>
  estimateContext({ mark: null, transcript: items, fixedChars: 0, imageTokens: 1600 });

describe("reduceForSummary", () => {
  const budget = 5000;

  test("leaves a transcript that fits alone", () => {
    const items: TranscriptItem[] = [{ kind: "user", parts: [text("hi")] }, ...round(1, 100)];
    expect(reduceForSummary(items, { budget, extraChars: 0, imageTokens: 1600 })).toEqual({ items, reduced: false });
  });

  // spec: AC-CTX-20
  test("a transcript 20% over the budget is made to fit, keeping the first user message and the last item", () => {
    const first: TranscriptItem = { kind: "user", parts: [text("the task")] };
    const items = [first, ...Array.from({ length: 12 }, (_, i) => round(i, 1900)).flat()];
    expect(sizeOf(items)).toBeGreaterThan(budget * 1.2);
    const r = reduceForSummary(items, { budget, extraChars: 0, imageTokens: 1600 });
    expect(r.reduced).toBe(true);
    expect(sizeOf(r.items)).toBeLessThanOrEqual(budget);
    expect(r.items[0]?.kind === "user" && r.items[0].parts[0]).toEqual(text("the task"));
    expect(r.items.at(-1)).toEqual(items.at(-1) as TranscriptItem);
  });

  test("replaces images with a placeholder before touching text", () => {
    const first: TranscriptItem = { kind: "user", parts: [text("look"), image] };
    const items = [first, ...round(1, 3000, [image])];
    const r = reduceForSummary(items, { budget: 4000, extraChars: 0, imageTokens: 1600 });
    const dump = JSON.stringify(r.items);
    expect(dump).not.toContain('"kind":"image"');
    expect(dump).toContain("[image: abababab.png]");
    expect(dump).toContain("r".repeat(3000));
  });

  test("cuts long tool results to their first and last 1,000 characters", () => {
    const items: TranscriptItem[] = [{ kind: "user", parts: [text("go")] }, ...round(1, 9000)];
    const r = reduceForSummary(items, { budget: 2000, extraChars: 0, imageTokens: 1600 });
    const result = r.items[2];
    const out =
      result?.kind === "user" && result.parts[0]?.kind === "tool_result" ? result.parts[0].content[0] : undefined;
    expect(out?.kind === "text" && out.text.startsWith("r".repeat(1000))).toBe(true);
    expect(out?.kind === "text" && out.text.endsWith("r".repeat(1000))).toBe(true);
    expect(out?.kind === "text" && out.text.length).toBeLessThan(2200);
  });

  test("dropping turns keeps every remaining tool call paired with its result", () => {
    const items = [
      { kind: "user", parts: [text("go")] } as TranscriptItem,
      ...Array.from({ length: 30 }, (_, i) => round(i, 1800)).flat(),
    ];
    const r = reduceForSummary(items, { budget: 3000, extraChars: 0, imageTokens: 1600 });
    const calls = r.items.flatMap((i) =>
      i.kind === "assistant" ? i.stored.parts.flatMap((p) => (p.kind === "tool_call" ? [p.id] : [])) : [],
    );
    const results = r.items.flatMap((i) =>
      i.kind === "user" ? i.parts.flatMap((p) => (p.kind === "tool_result" ? [p.callId] : [])) : [],
    );
    expect(results.sort()).toEqual(calls.sort());
  });
});
