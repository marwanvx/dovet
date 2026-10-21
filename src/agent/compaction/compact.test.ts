// Compaction end to end over an event list (context §6 "Procedure", "Undo").
import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "../../ai/index.ts";
import type { EpochStartData, EventEnvelope, StoredResponse } from "../../schema/index.ts";
import { buildRequest, headerOf } from "../transcript/index.ts";
import { compact, undoCompaction } from "./compact.ts";
import type { SummaryReply } from "./summarize.ts";

let n = 0;
let at = 0;
function ev(type: string, data: unknown, epoch: number, turn: number | null = 1): EventEnvelope {
  n += 1;
  at += 1;
  return {
    v: 1,
    id: `01J${String(n).padStart(23, "0")}`,
    ts: new Date(Date.UTC(2026, 9, 22, 0, 0, 0, at)).toISOString(),
    session: "01J00000000000000000000000",
    epoch,
    turn,
    type,
    core: true,
    data,
  } as EventEnvelope;
}
const startData = (epoch: number, systemText = "SYSTEM v1"): EpochStartData => ({
  epoch,
  reason: epoch === 0 ? "session-start" : "compaction",
  provider: "example",
  model: "m",
  systemText,
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

/** Turn 1 reads and edits a file, turn 2's prompt is pending. */
function session(extra: EventEnvelope[] = []): EventEnvelope[] {
  return [
    ev("epoch.start", startData(0), 0, null),
    ev("user.message", { text: "build X, and never touch /etc" }, 0, 1),
    ev(
      "model.response",
      response([{ kind: "tool_call", id: "c1", name: "Read", inputJson: '{"file_path":"/w/a.ts"}' }]),
      0,
      1,
    ),
    ev(
      "tool.call",
      { callId: "c1", name: "Read", raw: { file_path: "/w/a.ts" }, input: { file_path: "/w/a.ts" } },
      0,
      1,
    ),
    ev("tool.result", { callId: "c1", status: "ok", output: "contents" }, 0, 1),
    ev("file.change", { path: "/w/a.ts", op: "modify", added: 3, removed: 1, via: "Edit" }, 0, 1),
    ev("model.response", response([{ kind: "text", text: "done with X" }]), 0, 1),
    ev("turn.end", { reason: "end_turn" }, 0, 1),
    ev("user.message", { text: "now do Y" }, 0, 2),
    ...extra,
  ];
}

const facts = { mode: "default", tainted: [], grants: [], workingDirs: ["/w"], plan: null };
const ok = (text: string): SummaryReply => ({
  ok: true,
  stored: response([{ kind: "text", text }]),
  stopReason: "end_turn",
  costUsd: 0.01,
});
const fail = (message = "overloaded"): SummaryReply => ({ ok: false, message, aborted: false });

function input(events: EventEnvelope[], send: (t: TranscriptItem[]) => Promise<SummaryReply>, over = {}) {
  const started = events.findLast((e) => e.type === "epoch.start");
  const data = started?.data as EpochStartData;
  return {
    events,
    header: headerOf(data),
    params: { maxTokens: 4096 },
    cache: { breakpoints: "auto", ttl: "auto" } as const,
    trigger: "auto" as const,
    window: 200_000,
    imageTokens: 1600,
    tokensBefore: 1000,
    facts,
    renderSystem: () => Promise.resolve("SYSTEM v2"),
    send,
    ...over,
  };
}

const textOf = (item: TranscriptItem | undefined): string =>
  item?.kind === "user" ? item.parts.map((p) => (p.kind === "text" ? p.text : "")).join("\n") : "";

describe("compact", () => {
  // spec: AC-CTX-19
  test("the new epoch starts with the user's words, the summary and the Dovet facts; the pending message follows", async () => {
    const seen: TranscriptItem[][] = [];
    const r = await compact(
      input(session(), (t) => {
        seen.push(t);
        return Promise.resolve(ok("SUMMARY TEXT"));
      }),
    );
    if ("aborted" in r) throw new Error("aborted");
    expect(r.epochStart.epoch).toBe(1);
    expect(r.epochStart.reason).toBe("compaction");
    expect(r.epochStart.systemText).toBe("SYSTEM v2");
    expect(r.epochStart.toolsJson).toBe('[{"name":"Read"}]');
    const first = r.compaction.firstMessage;
    expect(first).toContain("build X, and never touch /etc");
    expect(first).not.toContain("now do Y");
    expect(first).toContain("SUMMARY TEXT");
    expect(first).toContain("/w/a.ts: modify (+3 −1)");
    expect(first).toContain("Read /w/a.ts → ok: contents");
    expect(r.pending).toEqual({ text: "now do Y", turn: 2 });
    expect(r.compaction).toMatchObject({ from: 0, to: 1, trigger: "auto", kind: "summary", reduced: false });
    const prompt = textOf(seen[0]?.at(-1));
    expect(prompt).toContain("User's requests and constraints");
    expect(seen[0]?.[0]).toEqual({ kind: "user", parts: [{ kind: "text", text: "build X, and never touch /etc" }] });
  });

  // spec: AC-CTX-19
  test("a transcript built for the new epoch is the first message then the pending message in one user message", async () => {
    const events = session();
    const r = await compact(input(events, () => Promise.resolve(ok("S"))));
    if ("aborted" in r) throw new Error("aborted");
    const all = [
      ...events,
      ev("epoch.start", r.epochStart, 1, null),
      ev("compaction", r.compaction, 1, null),
      ev("user.message", { text: "now do Y" }, 1, 2),
    ];
    const built = buildRequest(all, {
      header: headerOf(r.epochStart),
      params: { maxTokens: 1 },
      cache: { breakpoints: "auto", ttl: "auto" },
    });
    expect(built.transcript).toHaveLength(1);
    const item = built.transcript[0];
    expect(item?.kind === "user" && item.parts.map((p) => (p.kind === "text" ? p.text : ""))).toEqual([
      r.compaction.firstMessage,
      "now do Y",
    ]);
  });

  // spec: AC-CTX-20
  test("a summary containing $& and $1 is inserted unchanged", async () => {
    const summary = "Paid $& for $1 and $` too";
    const r = await compact(input(session(), () => Promise.resolve(ok(summary))));
    if ("aborted" in r) throw new Error("aborted");
    expect(r.compaction.firstMessage).toContain(summary);
  });

  // spec: AC-CTX-20
  test("a model that calls a tool is answered with errors and asked once more", async () => {
    const calls: TranscriptItem[][] = [];
    const withCall: SummaryReply = {
      ok: true,
      stored: response([{ kind: "tool_call", id: "s1", name: "Read", inputJson: "{}" }]),
      stopReason: "tool_use",
      costUsd: 0.01,
    };
    const replies = [withCall, ok("SECOND TRY")];
    const r = await compact(
      input(session(), (t) => {
        calls.push(t);
        return Promise.resolve(replies.shift() ?? fail());
      }),
    );
    if ("aborted" in r) throw new Error("aborted");
    expect(r.compaction.kind).toBe("summary");
    expect(r.compaction.firstMessage).toContain("SECOND TRY");
    const retry = calls[1] ?? [];
    const answer = retry.at(-1);
    expect(answer?.kind === "user" && answer.parts[0]).toMatchObject({
      kind: "tool_result",
      callId: "s1",
      isError: true,
    });
  });

  // spec: AC-CTX-20
  test("a model that still calls a tool gets the mechanical fallback", async () => {
    const withCall: SummaryReply = {
      ok: true,
      stored: response([{ kind: "tool_call", id: "s1", name: "Read", inputJson: "{}" }]),
      stopReason: "tool_use",
      costUsd: null,
    };
    const r = await compact(input(session(), () => Promise.resolve(withCall)));
    if ("aborted" in r) throw new Error("aborted");
    expect(r.compaction.kind).toBe("mechanical-fallback");
  });

  // spec: AC-CTX-20
  test("the summary model failing twice gives the mechanical fallback, announced, with the words and facts kept", async () => {
    let sent = 0;
    const r = await compact(
      input(session(), () => {
        sent++;
        return Promise.resolve(fail());
      }),
    );
    if ("aborted" in r) throw new Error("aborted");
    expect(sent).toBe(2);
    expect(r.compaction.kind).toBe("mechanical-fallback");
    expect(r.notice).toContain("no summary");
    expect(r.compaction.firstMessage).toContain("build X, and never touch /etc");
    expect(r.compaction.firstMessage).toContain("/w/a.ts: modify");
    expect(r.compaction.firstMessage).toContain("No summary was written");
  });

  // spec: AC-CTX-20
  test("a failover model is tried once after two failures", async () => {
    let sent = 0;
    const r = await compact(
      input(
        session(),
        () => {
          sent++;
          return Promise.resolve(fail());
        },
        {
          failover: () => Promise.resolve(ok("FROM FAILOVER")),
        },
      ),
    );
    if ("aborted" in r) throw new Error("aborted");
    expect(sent).toBe(2);
    expect(r.compaction.firstMessage).toContain("FROM FAILOVER");
  });

  test("an aborted summary request stops compaction without a result", async () => {
    const r = await compact(input(session(), () => Promise.resolve({ ok: false, message: "stopped", aborted: true })));
    expect("aborted" in r).toBe(true);
  });

  // spec: AC-CTX-20
  test("forced compaction on a transcript 20% over the window succeeds through the reduced request", async () => {
    const window = 30_000;
    const big = (i: number) => [
      ev("model.response", response([{ kind: "tool_call", id: `b${i}`, name: "Read", inputJson: "{}" }]), 0, 1),
      ev("tool.call", { callId: `b${i}`, name: "Read", raw: {}, input: {} }, 0, 1),
      ev("tool.result", { callId: `b${i}`, status: "ok", output: "x".repeat(2_800) }, 0, 1),
    ];
    const events = session(Array.from({ length: 12 }, (_, i) => big(i)).flat());
    const sizes: number[] = [];
    const send = (t: TranscriptItem[]): Promise<SummaryReply> => {
      const chars = JSON.stringify(t).length;
      sizes.push(chars);
      return Promise.resolve(chars / 3.5 > window - 25_000 + 1000 ? fail("context_exceeded") : ok("REDUCED SUMMARY"));
    };
    const r = await compact(input(events, send, { window, trigger: "context-exceeded" }));
    if ("aborted" in r) throw new Error("aborted");
    expect(r.compaction.kind).toBe("summary");
    expect(r.compaction.reduced).toBe(true);
    expect(r.compaction.trigger).toBe("context-exceeded");
    expect(r.compaction.firstMessage).toContain("REDUCED SUMMARY");
  });

  test("a second compaction carries the first one's retained messages and truncates from the front past the budget", async () => {
    const first = await compact(input(session(), () => Promise.resolve(ok("S1"))));
    if ("aborted" in first) throw new Error("aborted");
    const events = [
      ...session(),
      ev("epoch.start", first.epochStart, 1, null),
      ev("compaction", first.compaction, 1, null),
      ev("user.message", { text: "now do Y" }, 1, 2),
      ev("model.response", response([{ kind: "text", text: "ok Y" }]), 1, 2),
      ev("user.message", { text: "z".repeat(40_000) }, 1, 3),
    ];
    const second = await compact(input(events, () => Promise.resolve(ok("S2")), { window: 100_000 }));
    if ("aborted" in second) throw new Error("aborted");
    expect(second.compaction.from).toBe(1);
    expect(second.compaction.to).toBe(2);
    expect(second.compaction.retained).toEqual(["build X, and never touch /etc", "now do Y"]);
    expect(second.pending?.text).toBe("z".repeat(40_000));
  });
});

describe("undoCompaction", () => {
  async function compacted() {
    const events = session();
    const r = await compact(input(events, () => Promise.resolve(ok("S"))));
    if ("aborted" in r) throw new Error("aborted");
    return [
      ...events,
      ev("epoch.start", r.epochStart, 1, null),
      ev("compaction", r.compaction, 1, null),
      ev("user.message", { text: "now do Y" }, 1, 2),
    ];
  }
  const cache = { breakpoints: "auto", ttl: "auto" } as const;

  // spec: AC-CTX-13
  test("restores the previous transcript byte for byte, and the same header text", async () => {
    const events = await compacted();
    const before = buildRequest(events, { header: headerOf(startData(0)), params: { maxTokens: 1 }, cache });
    const u = undoCompaction(events);
    if ("refused" in u) throw new Error(u.refused);
    expect(u.epochStart.epoch).toBe(2);
    expect(u.epochStart.systemText).toBe("SYSTEM v1");
    const after = [...events, ev("epoch.start", u.epochStart, 2, null), ev("compaction", u.compaction, 2, null)];
    const restored = buildRequest(after, { header: headerOf(u.epochStart), params: { maxTokens: 1 }, cache });
    expect(JSON.stringify(restored.transcript)).toBe(JSON.stringify(before.transcript));
    expect(u.compaction).toMatchObject({ kind: "undo", from: 1, to: 2, restores: 0 });
  });

  // spec: AC-CTX-13
  test("work after an undo continues the restored epoch and not the compacted one", async () => {
    const events = await compacted();
    const u = undoCompaction(events);
    if ("refused" in u) throw new Error(u.refused);
    const after = [
      ...events,
      ev("epoch.start", u.epochStart, 2, null),
      ev("compaction", u.compaction, 2, null),
      ev("model.response", response([{ kind: "text", text: "after undo" }]), 2, 2),
    ];
    const built = buildRequest(after, { header: headerOf(u.epochStart), params: { maxTokens: 1 }, cache });
    const kinds = built.transcript.map((i) => i.kind);
    expect(kinds.at(-1)).toBe("assistant");
    expect(JSON.stringify(built.transcript)).not.toContain("SUMMARY");
    expect(JSON.stringify(built.transcript)).toContain("build X, and never touch /etc");
  });

  // spec: AC-CTX-13
  test("is refused once a request has been sent in the new epoch", async () => {
    const events = [...(await compacted()), ev("model.request", {}, 1, 2)];
    const u = undoCompaction(events);
    expect("refused" in u && u.refused).toContain("next request");
  });

  test("is refused when nothing was compacted, and after it was undone", async () => {
    expect("refused" in undoCompaction(session())).toBe(true);
    const events = await compacted();
    const u = undoCompaction(events);
    if ("refused" in u) throw new Error(u.refused);
    const after = [...events, ev("epoch.start", u.epochStart, 2, null), ev("compaction", u.compaction, 2, null)];
    expect("refused" in undoCompaction(after)).toBe(true);
  });
});

describe("the transcript builder after a compaction", () => {
  const cache = { breakpoints: "auto", ttl: "auto" } as const;

  test("a repair epoch after a compaction continues from the first message, not from the compacted turns", async () => {
    const events = session();
    const r = await compact(input(events, () => Promise.resolve(ok("S"))));
    if ("aborted" in r) throw new Error("aborted");
    const repair = { ...startData(2), reason: "repair" as const };
    const all = [
      ...events,
      ev("epoch.start", r.epochStart, 1, null),
      ev("compaction", r.compaction, 1, null),
      ev("user.message", { text: "now do Y" }, 1, 2),
      ev("model.response", response([{ kind: "text", text: "Y done" }]), 1, 2),
      ev("epoch.start", repair, 2, null),
    ];
    const built = buildRequest(all, { header: headerOf(repair), params: { maxTokens: 1 }, cache });
    const dump = JSON.stringify(built.transcript);
    expect(dump).toContain(JSON.stringify(r.compaction.firstMessage).slice(1, -1));
    expect(dump).toContain("Y done");
    expect(dump).not.toContain("done with X");
    expect(built.transcript[0]?.kind).toBe("user");
  });
});
