// A compaction as events to append, and its undo (context §6 "Shape", "Procedure", "Undo").
import type { EpochHeader, RenderInput } from "../../ai/index.ts";
import {
  CompactionData,
  EpochStartData,
  type EventEnvelope,
  TurnEndData,
  UserMessageData,
} from "../../schema/index.ts";
import { CHARS_PER_TOKEN } from "../budgets/estimate.ts";
import { buildRequest, epochLineage, startEpoch } from "../transcript/index.ts";
import { prompt } from "../transcript/prompts.ts";
import { collectFacts, type FactsState, renderFacts } from "./facts.ts";
import { renderFirstMessage, retainBudget, retainUserMessages } from "./first-message.ts";
import { type SendSummary, summarize } from "./summarize.ts";

export type CompactInput = {
  events: readonly EventEnvelope[];
  header: EpochHeader;
  params: RenderInput["params"];
  cache: RenderInput["cache"];
  trigger: CompactionData["trigger"];
  /** Extra instructions after `/compact`. */
  focus?: string;
  window: number;
  imageTokens: number;
  tokensBefore: number;
  facts: FactsState;
  /** The system prompt as it reads now (current git branch, date, mode). */
  renderSystem(): Promise<string>;
  send: SendSummary;
  failover?: SendSummary;
};

export type CompactResult = {
  epochStart: EpochStartData;
  compaction: CompactionData;
  /** The user message that was waiting; it is logged again in the new epoch. */
  pending: { text: string; turn: number } | null;
  /** Shown to the user when the summary could not be written. */
  notice: string | null;
  costUsd: number | null;
};

const maxEpoch = (events: readonly EventEnvelope[]): number =>
  events.reduce((n, e) => (e.type === "epoch.start" ? Math.max(n, EpochStartData.parse(e.data).epoch) : n), 0);

/** The user messages of the epoch's lineage, oldest first, with the one still waiting for an answer split off. */
function userWords(
  events: readonly EventEnvelope[],
  epoch: number,
): { words: string[]; pending: CompactResult["pending"] } {
  const lineage = epochLineage(events, epoch);
  const cancelled = new Set(
    events.flatMap((e) =>
      e.type === "turn.end" && e.turn !== null && TurnEndData.parse(e.data).reason === "cancelled" ? [e.turn] : [],
    ),
  );
  const words = [...(lineage.base?.retained ?? [])];
  let pendingIndex = -1;
  const mine = events.filter((e) => lineage.epochs.has(e.epoch) && (e.turn === null || !cancelled.has(e.turn)));
  for (const e of mine) if (e.type === "user.message") words.push(UserMessageData.parse(e.data).text);
  for (const e of mine.toReversed()) {
    if (e.type === "model.response" || e.type === "tool.result") break;
    if (e.type === "user.message") {
      pendingIndex = words.length - 1;
      return {
        words: words.filter((_, i) => i !== pendingIndex),
        pending: { text: UserMessageData.parse(e.data).text, turn: e.turn ?? 0 },
      };
    }
  }
  return { words, pending: null };
}

export async function compact(a: CompactInput): Promise<CompactResult | { aborted: true }> {
  const transcript = buildRequest(a.events, { header: a.header, params: a.params, cache: a.cache }).transcript;
  const promptText =
    a.focus === undefined || a.focus.trim() === ""
      ? prompt("compact.md")
      : `${prompt("compact.md")}\n\nFocus for this summary: ${a.focus.trim()}`;
  const summary = await summarize({
    transcript,
    promptText,
    window: a.window,
    fixedChars: a.header.systemText.length + a.header.toolsJson.length,
    imageTokens: a.imageTokens,
    send: a.send,
    ...(a.failover === undefined ? {} : { failover: a.failover }),
  });
  if (summary.kind === "aborted") return { aborted: true };
  const { words, pending } = userWords(a.events, a.header.epoch);
  const { kept, omitted } = retainUserMessages(words, retainBudget(a.window));
  const firstMessage = renderFirstMessage({
    kept,
    omitted,
    summary: summary.kind === "summary" ? summary.text : null,
    facts: renderFacts(collectFacts(a.events, a.facts)),
  });
  const epoch = maxEpoch(a.events) + 1;
  const systemText = await a.renderSystem();
  const started = startEpoch({
    epoch,
    reason: "compaction",
    provider: a.header.provider,
    model: a.header.model,
    systemText,
    toolsJson: a.header.toolsJson,
    thinking: a.header.thinking,
  });
  const chars = systemText.length + a.header.toolsJson.length + firstMessage.length + (pending?.text.length ?? 0);
  return {
    epochStart: started.event,
    compaction: CompactionData.parse({
      from: a.header.epoch,
      to: epoch,
      trigger: a.trigger,
      kind: summary.kind === "summary" ? "summary" : "mechanical-fallback",
      firstMessage,
      retained: kept,
      reduced: summary.reduced,
      tokensBefore: Math.round(a.tokensBefore),
      tokensAfter: Math.ceil(chars / CHARS_PER_TOKEN),
      ...(summary.kind === "summary" ? { usage: summary.usage } : {}),
      costUsd: summary.costUsd,
    }),
    pending,
    notice:
      summary.kind === "summary"
        ? null
        : `Compaction wrote no summary (${summary.why}); kept your earlier messages and the recorded facts instead.`,
    costUsd: summary.costUsd,
  };
}

/** Only before the next request is sent; the earlier epoch's header and events are used as they are (context §6 "Undo"). */
export function undoCompaction(
  events: readonly EventEnvelope[],
): { epochStart: EpochStartData; compaction: CompactionData } | { refused: string } {
  const at = events.findLastIndex((e) => e.type === "compaction");
  const last = at < 0 ? undefined : events[at];
  if (last === undefined) return { refused: "Nothing to undo: this session has not been compacted." };
  const c = CompactionData.parse(last.data);
  if (c.kind === "undo") return { refused: "Nothing to undo: the last compaction was already undone." };
  if (events.slice(at + 1).some((e) => e.type === "model.request"))
    return { refused: "Can't undo: the next request was already sent." };
  const old = events.findLast((e) => e.type === "epoch.start" && EpochStartData.parse(e.data).epoch === c.from);
  if (old === undefined) return { refused: "Can't undo: the earlier epoch's header is missing from the log." };
  const epoch = maxEpoch(events) + 1;
  return {
    epochStart: { ...EpochStartData.parse(old.data), epoch, reason: "compaction" },
    compaction: CompactionData.parse({
      from: c.to,
      to: epoch,
      trigger: "manual",
      kind: "undo",
      restores: c.from,
      firstMessage: "",
      retained: [],
      reduced: false,
      tokensBefore: c.tokensAfter,
      tokensAfter: c.tokensBefore,
    }),
  };
}
