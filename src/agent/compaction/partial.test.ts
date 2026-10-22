// "Summarize up to here" (checkpoints "Rewind", context §6 "Partial compaction"): the summary covers turns before k, turns from k stay.
import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "../../ai/index.ts";
import type { EpochStartData, EventEnvelope, StoredResponse } from "../../schema/index.ts";
import { buildRequest, headerOf } from "../transcript/index.ts";
import { compact, undoCompaction } from "./compact.ts";
import type { SummaryReply } from "./summarize.ts";

let n = 0;
function ev(type: string, data: unknown, epoch: number, turn: number | null): EventEnvelope {
  n += 1;
  return {
    v: 1,
    id: `01J${String(n).padStart(23, "0")}`,
    ts: new Date(Date.UTC(2026, 9, 22, 0, 0, 0, n)).toISOString(),
    session: "01J00000000000000000000000",
    epoch,
    turn,
    type,
    core: true,
    data,
  } as EventEnvelope;
}
const startData = (epoch: number): EpochStartData => ({
  epoch,
  reason: epoch === 0 ? "session-start" : "compaction",
  provider: "example",
  model: "m",
  systemText: "SYSTEM",
  toolsJson: '[{"name":"Read"}]',
  thinking: { mode: "off" },
  promptVersion: "0".repeat(64),
});
const response = (parts: StoredResponse["parts"]) =>
  ({
    provider: "example",
    protocol: "openai-chat",
    package: "x",
    packageVersion: "1",
    modelId: "m",
    parts,
    usage: { promptTokens: 10, completionTokens: 5 },
    finishReason: "stop",
  }) satisfies StoredResponse;

/** Nine turns; every answer carries a reasoning block, and turn 7 reads a file first. */
function nine(): EventEnvelope[] {
  const out: EventEnvelope[] = [ev("epoch.start", startData(0), 0, null)];
  for (let t = 1; t <= 9; t++) {
    out.push(ev("user.message", { text: `ask ${t}` }, 0, t));
    if (t === 7) {
      out.push(
        ev(
          "model.response",
          response([
            { kind: "reasoning", summary: "thinking about the read" },
            { kind: "tool_call", id: "c7", name: "Read", inputJson: '{"file_path":"/w/a.ts"}' },
          ]),
          0,
          t,
        ),
        ev("tool.call", { callId: "c7", name: "Read", raw: {}, input: {} }, 0, t),
        ev("tool.result", { callId: "c7", status: "ok", output: "file seven" }, 0, t),
      );
    }
    out.push(
      ev(
        "model.response",
        response([
          { kind: "reasoning", summary: `thought ${t}` },
          { kind: "text", text: `answer ${t}` },
        ]),
        0,
        t,
      ),
      ev("turn.end", { reason: "end_turn" }, 0, t),
    );
  }
  return out;
}

const ok = (text: string): SummaryReply => ({
  ok: true,
  stored: response([{ kind: "text", text }]),
  stopReason: "end_turn",
  costUsd: 0.01,
});
const facts = { mode: "default", tainted: [], grants: [], workingDirs: ["/w"], plan: null };

function input(events: EventEnvelope[], send: (t: TranscriptItem[]) => Promise<SummaryReply>, over = {}) {
  const started = events.findLast((e) => e.type === "epoch.start");
  return {
    events,
    header: headerOf(started?.data as EpochStartData),
    params: { maxTokens: 4096 },
    cache: { breakpoints: "auto", ttl: "auto" } as const,
    trigger: "partial" as const,
    window: 200_000,
    imageTokens: 1600,
    tokensBefore: 1000,
    facts,
    renderSystem: () => Promise.resolve("SYSTEM"),
    send,
    ...over,
  };
}

const textOf = (item: TranscriptItem | undefined): string =>
  item === undefined
    ? ""
    : item.kind === "system"
      ? item.text
      : (item.kind === "user" ? item.parts : item.stored.parts)
          .map((p) => (p.kind === "text" ? p.text : p.kind === "tool_result" ? JSON.stringify(p.content) : ""))
          .join("\n");

async function summarizeUpTo(events: EventEnvelope[], upToTurn: number) {
  const seen: TranscriptItem[][] = [];
  const r = await compact(
    input(
      events,
      (t) => {
        seen.push(t);
        return Promise.resolve(ok("SUMMARY OF EARLY TURNS"));
      },
      { upToTurn },
    ),
  );
  if ("aborted" in r) throw new Error("aborted");
  const all = [
    ...events,
    ev("epoch.start", r.epochStart, r.epochStart.epoch, null),
    ev("compaction", r.compaction, r.epochStart.epoch, null),
  ];
  return { r, seen, all };
}

describe("summarize up to here", () => {
  // spec: AC-CKPT-13
  test("at turn 5 of 9 the next request is the summary then turns 5-9 verbatim, without reasoning blocks", async () => {
    const { r, seen, all } = await summarizeUpTo(nine(), 5);
    const request = buildRequest(all, {
      header: headerOf(r.epochStart),
      params: { maxTokens: 4096 },
      cache: { breakpoints: "auto", ttl: "auto" },
    });
    const items = request.transcript;
    const [head, ...rest] = items;
    const firstMessage = head?.kind === "user" && head.parts[0]?.kind === "text" ? head.parts[0].text : "";
    expect(firstMessage).toContain("SUMMARY OF EARLY TURNS");
    for (const t of [1, 2, 3, 4]) expect(firstMessage).toContain(`ask ${t}`);
    expect(firstMessage).not.toContain("ask 5");
    const asks = [head, ...rest].flatMap((i) =>
      i?.kind === "user"
        ? i.parts.flatMap((p) => (p.kind === "text" && p.text.startsWith("ask ") ? [p.text] : []))
        : [],
    );
    expect(asks).toEqual(["ask 5", "ask 6", "ask 7", "ask 8", "ask 9"]);
    const answers = items.filter((i) => i.kind === "assistant").map(textOf);
    expect(answers.filter((s) => s !== "")).toEqual(["answer 5", "answer 6", "answer 7", "answer 8", "answer 9"]);
    expect(JSON.stringify(items.slice(1))).not.toContain("reasoning");
    expect(JSON.stringify(items.slice(1))).not.toContain("thought");
    expect(JSON.stringify(items.slice(1))).toContain("file seven");
    expect(JSON.stringify(items)).not.toContain("answer 4");
    expect(r.compaction).toMatchObject({ from: 0, to: 1, trigger: "partial", keepFromTurn: 5, kind: "summary" });
    expect(r.pending).toBeNull();
    const prefix = seen[0]?.map(textOf).join("\n") ?? "";
    expect(prefix).toContain("ask 4");
    expect(prefix).not.toContain("ask 5");
    expect(prefix).not.toContain("answer 5");
  });

  // spec: AC-CKPT-13
  test("the facts describe only the turns that were summarized", async () => {
    const events = nine();
    events.splice(
      events.findIndex((e) => e.type === "user.message" && e.turn === 6),
      0,
      ev("file.change", { path: "/w/early.ts", op: "create", added: 1, removed: 0, via: "Write" }, 0, 4),
    );
    events.push(ev("file.change", { path: "/w/late.ts", op: "create", added: 1, removed: 0, via: "Write" }, 0, 8));
    const { r } = await summarizeUpTo(events, 5);
    expect(r.compaction.firstMessage).toContain("/w/early.ts");
    expect(r.compaction.firstMessage).not.toContain("/w/late.ts");
  });

  // spec: AC-CKPT-13
  test("a later full compaction still carries the words of the summarized turns and of the kept ones", async () => {
    const first = await summarizeUpTo(nine(), 5);
    const events = [...first.all, ev("user.message", { text: "ask 10" }, 1, 10)];
    const second = await compact(input(events, () => Promise.resolve(ok("SECOND")), { trigger: "auto" }));
    if ("aborted" in second) throw new Error("aborted");
    for (const t of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(second.compaction.firstMessage).toContain(`ask ${t}`);
    expect(second.pending).toEqual({ text: "ask 10", turn: 10 });
  });

  // spec: AC-CKPT-13
  test("undo returns to the whole earlier transcript, reasoning included", async () => {
    const first = await summarizeUpTo(nine(), 5);
    const undone = undoCompaction(first.all);
    if ("refused" in undone) throw new Error(undone.refused);
    const all = [
      ...first.all,
      ev("epoch.start", undone.epochStart, undone.epochStart.epoch, null),
      ev("compaction", undone.compaction, undone.epochStart.epoch, null),
    ];
    const before = buildRequest(first.all.slice(0, nine().length), {
      header: headerOf(startData(0)),
      params: { maxTokens: 4096 },
      cache: { breakpoints: "auto", ttl: "auto" },
    });
    const after = buildRequest(all, {
      header: headerOf(undone.epochStart),
      params: { maxTokens: 4096 },
      cache: { breakpoints: "auto", ttl: "auto" },
    });
    expect(JSON.stringify(after.transcript)).toBe(JSON.stringify(before.transcript));
  });

  // spec: AC-CKPT-13
  test("turn 1 has nothing before it to summarize", async () => {
    await expect(summarizeUpTo(nine(), 1)).rejects.toThrow();
  });
});
