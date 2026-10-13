// Round-trips the interfaces §1, §2 and §2b types that have schemas so far (primitives, parts, StoredResponse, envelope, settings).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  AbsPath,
  BlobRef,
  EventEnvelope,
  InstructionReason,
  IsoTime,
  Part,
  PermissionMode,
  Protocol,
  ReplayData,
  Settings,
  StoredResponse,
  Ulid,
} from "./index.ts";

const SHA = "a".repeat(64);
const blob = { store: "blob", id: SHA } as const;
const replay: ReplayData = {
  provider: "nvidia",
  protocol: "openai-chat",
  modelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
  fields: { signature: "EqQBCkYI", nested: { a: [1, null, true] } },
};

function roundTrip<T>(schema: { parse(v: unknown): T }, value: unknown): T {
  const once = schema.parse(value);
  expect<unknown>(once).toEqual(value);
  const twice = schema.parse(JSON.parse(JSON.stringify(once)));
  expect(twice).toEqual(once);
  return once;
}

describe("primitives", () => {
  test("ULID and ISO time accept the documented shapes and nothing looser", () => {
    expect(Ulid.safeParse("01J9Z3K4M5N6P7Q8R9S0T1V2W3").success).toBe(true);
    expect(Ulid.safeParse("01J9Z3K4M5N6P7Q8R9S0T1V2W").success).toBe(false);
    expect(Ulid.safeParse("01J9Z3K4M5N6P7Q8R9S0T1V2WI").success).toBe(false);
    expect(Ulid.safeParse("81J9Z3K4M5N6P7Q8R9S0T1V2W3").success).toBe(false);
    expect(IsoTime.safeParse("2026-10-12T08:30:00.123Z").success).toBe(true);
    expect(IsoTime.safeParse("2026-10-12T08:30:00Z").success).toBe(false);
    expect(IsoTime.safeParse("2026-10-12 08:30:00.123").success).toBe(false);
  });

  test("AbsPath accepts POSIX, drive and UNC paths and refuses relative ones", () => {
    for (const p of ["/home/u/project", "C:\\Users\\u\\project", "C:/Users/u", "\\\\server\\share\\x"]) {
      expect(AbsPath.safeParse(p).success).toBe(true);
    }
    for (const p of ["", "src/a.ts", "./a", "~/a"]) expect(AbsPath.safeParse(p).success).toBe(false);
  });

  test("BlobRef ids match their store: sha256 for blobs, a git object id for git", () => {
    roundTrip(BlobRef, blob);
    roundTrip(BlobRef, { store: "git", id: "b".repeat(40) });
    expect(BlobRef.safeParse({ store: "blob", id: "b".repeat(40) }).success).toBe(false);
    expect(BlobRef.safeParse({ store: "git", id: "xyz" }).success).toBe(false);
  });

  test("Protocol lists exactly the four protocols", () => {
    expect([...Protocol.options].sort()).toEqual([
      "anthropic-messages",
      "google-interactions",
      "openai-chat",
      "openai-responses",
    ]);
  });

  test("PermissionMode takes the six modes and the manual alias is not a stored mode", () => {
    for (const m of ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "auto"]) {
      expect(PermissionMode.safeParse(m).success).toBe(true);
    }
    expect(PermissionMode.safeParse("manual").success).toBe(false);
  });
});

describe("Part", () => {
  const examples: unknown[] = [
    { kind: "text", text: "hello", phase: "final_answer", replay },
    { kind: "text", text: "plain" },
    { kind: "image", blob, mediaType: "image/png" },
    { kind: "document", blob, mediaType: "application/pdf", title: "spec.pdf" },
    { kind: "reasoning", summary: null, replay },
    { kind: "reasoning", summary: "weighed two options" },
    { kind: "tool_call", id: "toolu_01", name: "Read", inputJson: '{"file_path":"/a"}', replay },
    {
      kind: "tool_result",
      callId: "toolu_01",
      isError: false,
      content: [
        { kind: "text", text: "ok" },
        { kind: "image", blob, mediaType: "image/webp" },
        { kind: "document", blob, mediaType: "application/pdf" },
      ],
    },
    { kind: "instruction", text: "You were interrupted.", reason: "interrupt-note" },
  ];

  test.each(examples)("round-trips %p", (example) => {
    roundTrip(Part, example);
  });

  test("every instruction reason of prompts/instructions.md is accepted, others are not", () => {
    for (const reason of InstructionReason.options) {
      expect(Part.safeParse({ kind: "instruction", text: "x", reason }).success).toBe(true);
    }
    expect(InstructionReason.options).toHaveLength(16);
    expect(Part.safeParse({ kind: "instruction", text: "x", reason: "made-up" }).success).toBe(false);
  });

  test("a tool result cannot nest a tool call or another tool result", () => {
    const nested = { kind: "tool_result", callId: "c", isError: false, content: [examples[6]] };
    expect(Part.safeParse(nested).success).toBe(false);
  });

  test("every image media type of the spec is accepted", () => {
    for (const mediaType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(Part.safeParse({ kind: "image", blob, mediaType }).success).toBe(true);
    }
  });

  test("a reasoning part must say whether it has a summary (string or null)", () => {
    expect(Part.safeParse({ kind: "reasoning" }).success).toBe(false);
  });

  test("unknown kinds, bad media types and missing fields are refused", () => {
    expect(Part.safeParse({ kind: "video", blob }).success).toBe(false);
    expect(Part.safeParse({ kind: "image", blob, mediaType: "image/bmp" }).success).toBe(false);
    expect(Part.safeParse({ kind: "tool_call", id: "x", name: "Read" }).success).toBe(false);
    expect(Part.safeParse({ kind: "text", text: "x", phase: "thinking" }).success).toBe(false);
  });
});

describe("ReplayData", () => {
  test("keeps the provider's fields verbatim", () => {
    expect(roundTrip(ReplayData, replay).fields).toEqual(replay.fields);
  });

  test("refuses values that are not JSON", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, 10n]) {
      expect(ReplayData.safeParse({ ...replay, fields: { x: bad } }).success).toBe(false);
    }
  });
});

describe("StoredResponse", () => {
  const stored = {
    provider: "nvidia",
    protocol: "openai-chat",
    package: "@ai-sdk/openai-compatible",
    packageVersion: "4.0.0",
    modelId: "nvidia/nemotron-3.5-lightning-30b-a3b",
    parts: [
      { kind: "reasoning", summary: null, replay },
      { kind: "text", text: "done", phase: "final_answer" },
      { kind: "tool_call", id: "toolu_01", name: "Read", inputJson: "{}" },
    ],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, service_tier: "standard" },
    finishReason: "tool_use",
  };

  test("round-trips with and without the debug raw body", () => {
    roundTrip(StoredResponse, stored);
    roundTrip(StoredResponse, { ...stored, rawBody: blob });
  });

  test("keeps the provider usage object verbatim, nested values included", () => {
    const usage = { server_tool_use: { web_search_requests: 2 }, extra: [1, 2] };
    expect(roundTrip(StoredResponse, { ...stored, usage }).usage).toEqual(usage);
  });

  test("a bad part inside the response is refused", () => {
    expect(StoredResponse.safeParse({ ...stored, parts: [{ kind: "text" }] }).success).toBe(false);
  });
});

describe("EventEnvelope", () => {
  const envelope = {
    v: 1,
    id: "01J9Z3K4M5N6P7Q8R9S0T1V2W3",
    ts: "2026-10-12T08:30:00.123Z",
    session: "01J9Z3K4M5N6P7Q8R9S0T1V2W4",
    epoch: 0,
    turn: null,
    type: "session.start",
    core: true,
    data: { anything: ["goes", 1] },
  };

  test("round-trips, data stays opaque until the event's own schema validates it", () => {
    roundTrip(EventEnvelope, envelope);
    expect(roundTrip(EventEnvelope, { ...envelope, turn: 3 }).turn).toBe(3);
  });

  test("refuses another schema version, a bad id or time, and a negative counter", () => {
    expect(EventEnvelope.safeParse({ ...envelope, v: 2 }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...envelope, id: "not-a-ulid" }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...envelope, ts: "yesterday" }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...envelope, epoch: -1 }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...envelope, turn: 1.5 }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...envelope, core: "yes" }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...envelope, type: "" }).success).toBe(false);
  });
});

describe("Settings", () => {
  test("round-trips the skeleton keys", () => {
    const settings = {
      $version: 1,
      provider: "nvidia",
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      effort: "high",
      permissions: { defaultMode: "acceptEdits", allow: ["Read"], ask: [], deny: ["Bash(rm -rf *)"] },
      budget: { session: 5, daily: null, turn: 0.5 },
    };
    roundTrip(Settings, settings);
    roundTrip(Settings, {});
  });

  test('accepts "manual" as an alias of "default" for the default permission mode', () => {
    expect(Settings.parse({ permissions: { defaultMode: "manual" } }).permissions?.defaultMode).toBe("default");
  });

  test("refuses a value of the wrong kind", () => {
    expect(Settings.safeParse({ effort: "extreme" }).success).toBe(false);
    expect(Settings.safeParse({ permissions: { defaultMode: "auto" } }).success).toBe(false);
    expect(Settings.safeParse({ budget: { session: -1 } }).success).toBe(false);
  });
});

describe("zod version", () => {
  test("every import of zod from src/ resolves to major version 4", () => {
    const manifest = z
      .object({ version: z.string() })
      .parse(JSON.parse(readFileSync(Bun.resolveSync("zod/package.json", import.meta.dir), "utf8")));
    expect(manifest.version).toMatch(/^4\./);
  });
});
