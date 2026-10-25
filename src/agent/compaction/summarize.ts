// The summary request of a compaction: a fork that is never appended to the epoch (context §6 procedure 1, 3b, 4).
import type { StopReason, TranscriptItem } from "../../ai/index.ts";
import type { StoredResponse } from "../../schema/index.ts";
import type { Stop } from "../budgets/index.ts";
import { reduceForSummary } from "./reduce.ts";

export type SummaryReply =
  | { ok: true; stored: StoredResponse; stopReason: StopReason; costUsd: number | null }
  | {
      ok: false;
      message: string;
      aborted: boolean /** The budget refused this request (receipts-budgets "Behavior" 3); no retry can help. */;
      budget?: Stop;
    };

/** One summary request, with the retry budget the model call itself has. */
export type SendSummary = (transcript: TranscriptItem[]) => Promise<SummaryReply>;

export type Summarized =
  | { kind: "summary"; text: string; reduced: boolean; usage: StoredResponse["usage"]; costUsd: number | null }
  | { kind: "fallback"; why: string; reduced: boolean; costUsd: number | null }
  | { kind: "aborted" };

/** Left free of the window for the summary itself and the framing around it. */
export const SUMMARY_HEADROOM = 25_000;
const NO_TOOLS =
  "Tools are not available for this request. Write the summary now, as text only, in the sections asked for.";

const textOf = (stored: StoredResponse): string =>
  stored.parts
    .flatMap((p) => (p.kind === "text" ? [p.text] : []))
    .join("")
    .trim();

/** The fork: the epoch's own transcript with the compaction prompt as its last user message. */
export function forkTranscript(transcript: readonly TranscriptItem[], promptText: string): TranscriptItem[] {
  const out = [...transcript];
  const last = out.at(-1);
  const part = { kind: "text", text: promptText } as const;
  if (last?.kind === "user") out[out.length - 1] = { ...last, parts: [...last.parts, part] };
  else out.push({ kind: "user", parts: [part] });
  return out;
}

/**
 * Two attempts (the second reduces to 60% of the budget, in case the first estimate was too hopeful), then the failover
 * model once if there is one. A model that calls tools after being told not to goes straight to the fallback.
 */
export async function summarize(a: {
  transcript: readonly TranscriptItem[];
  promptText: string;
  window: number;
  fixedChars: number;
  imageTokens: number;
  send: SendSummary;
  failover?: SendSummary;
}): Promise<Summarized> {
  const fork = forkTranscript(a.transcript, a.promptText);
  const budget = Math.max(1000, a.window - SUMMARY_HEADROOM);
  let reduced = false;
  let costUsd: number | null = null;
  const addCost = (c: number | null): void => {
    if (c !== null) costUsd = (costUsd ?? 0) + c;
  };
  let why = "";
  const senders = [a.send, a.send, ...(a.failover === undefined ? [] : [a.failover])];
  for (const [attempt, send] of senders.entries()) {
    const cut = reduceForSummary(fork, {
      budget: attempt === 0 ? budget : Math.floor(budget * 0.6),
      extraChars: a.fixedChars,
      imageTokens: a.imageTokens,
    });
    reduced ||= cut.reduced;
    let reply = await send(cut.items);
    if (reply.ok && reply.stored.parts.some((p) => p.kind === "tool_call")) {
      addCost(reply.costUsd);
      const calls = reply.stored.parts.flatMap((p) => (p.kind === "tool_call" ? [p.id] : []));
      reply = await send([
        ...cut.items,
        { kind: "assistant", stored: reply.stored },
        {
          kind: "user",
          parts: [
            ...calls.map((callId) => ({
              kind: "tool_result" as const,
              callId,
              isError: true,
              content: [{ kind: "text" as const, text: NO_TOOLS }],
            })),
            { kind: "text", text: NO_TOOLS },
          ],
        },
      ]);
      if (reply.ok && reply.stored.parts.some((p) => p.kind === "tool_call")) {
        addCost(reply.costUsd);
        return { kind: "fallback", why: "the model kept calling tools", reduced, costUsd };
      }
    }
    if (!reply.ok) {
      if (reply.aborted || reply.budget !== undefined) return { kind: "aborted" };
      why = reply.message;
      continue;
    }
    addCost(reply.costUsd);
    const text = textOf(reply.stored);
    if (text === "" || reply.stopReason === "refusal") {
      why = text === "" ? "the summary was empty" : "the model refused";
      continue;
    }
    return { kind: "summary", text, reduced, usage: reply.stored.usage, costUsd };
  }
  return { kind: "fallback", why, reduced, costUsd };
}
