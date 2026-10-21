// The context estimate and the compaction triggers (context §6 "Token estimate" and "Triggers").
import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "../../ai/index.ts";
import type { Part, StoredResponse } from "../../schema/index.ts";
import { countImages, estimateContext, hasOpenRound, shouldCompact, transcriptChars } from "./estimate.ts";

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
const user = (text: string): TranscriptItem => ({ kind: "user", parts: [{ kind: "text", text }] });
const image = { kind: "image", blob: { store: "blob", id: "a".repeat(64) }, mediaType: "image/png" } as const;

describe("transcript size", () => {
  test("counts text, tool input and tool output, and every image once", () => {
    const items: TranscriptItem[] = [
      user("abcd"),
      { kind: "assistant", stored: stored([{ kind: "tool_call", id: "c1", name: "Read", inputJson: "{}" }]) },
      {
        kind: "user",
        parts: [{ kind: "tool_result", callId: "c1", isError: false, content: [{ kind: "text", text: "xyz" }, image] }],
      },
    ];
    expect(transcriptChars(items)).toBe(4 + "Read".length + 2 + 3);
    expect(countImages(items)).toBe(1);
  });
});

describe("estimateContext", () => {
  const sent: TranscriptItem[] = [user("a".repeat(350))];
  const mark = { tokens: { input: 100, cacheRead: 900, cacheWrite: 50, output: 40 }, chars: 350, images: 0 };

  // spec: AC-CTX-11
  test("last input (uncached, read, written) plus its output plus the new text over 3.5", () => {
    const now = [...sent, user("b".repeat(70))];
    expect(estimateContext({ mark, transcript: now, fixedChars: 5000, imageTokens: 1600 })).toBe(1050 + 40 + 20);
  });

  test("an image appended since adds the per-image estimate", () => {
    const now: TranscriptItem[] = [...sent, { kind: "user", parts: [image] }];
    expect(estimateContext({ mark, transcript: now, fixedChars: 0, imageTokens: 1600 })).toBe(1090 + 1600);
  });

  // spec: AC-CTX-20
  test("a response with no usage estimates the whole request from characters", () => {
    const now = [user("a".repeat(350))];
    expect(estimateContext({ mark: null, transcript: now, fixedChars: 700, imageTokens: 1600 })).toBe(300);
    const zero = { ...mark, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } };
    expect(estimateContext({ mark: zero, transcript: now, fixedChars: 700, imageTokens: 1600 })).toBe(300);
  });

  test("a transcript that shrank never goes below the last real usage", () => {
    expect(estimateContext({ mark, transcript: [user("a")], fixedChars: 0, imageTokens: 1600 })).toBe(1090);
  });
});

describe("shouldCompact", () => {
  const base = { window: 100_000, reserve: 4000, threshold: 0.9, maxTokens: null };

  // spec: AC-CTX-11
  test("triggers above threshold x (window - output reserve), not at it", () => {
    expect(shouldCompact({ ...base, tokens: 86_400 })).toBe(false);
    expect(shouldCompact({ ...base, tokens: 86_401 })).toBe(true);
  });

  test("compaction.maxTokens caps the trigger in absolute tokens", () => {
    expect(shouldCompact({ ...base, maxTokens: 50_000, tokens: 50_001 })).toBe(true);
    expect(shouldCompact({ ...base, maxTokens: 50_000, tokens: 50_000 })).toBe(false);
  });
});

describe("hasOpenRound", () => {
  const call = { kind: "tool_call", id: "c1", name: "Read", inputJson: "{}" } as const;
  const result: Part = { kind: "tool_result", callId: "c1", isError: false, content: [] };

  // spec: AC-CTX-11
  test("is true while a tool call has no result and false once every call is answered", () => {
    const open: TranscriptItem[] = [user("hi"), { kind: "assistant", stored: stored([call]) }];
    expect(hasOpenRound(open)).toBe(true);
    expect(hasOpenRound([...open, { kind: "user", parts: [result] }])).toBe(false);
    expect(hasOpenRound([user("hi")])).toBe(false);
  });
});
