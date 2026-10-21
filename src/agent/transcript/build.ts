// The pure transcript builder (agent-loop "Determinism contract of the transcript builder").
import type { RenderInput, TranscriptItem } from "../../ai/index.ts";
import {
  CompactionData,
  type EventEnvelope,
  type Part,
  StoredResponse,
  SystemInjectedData,
  ToolResultData,
  TurnEndData,
  UserMessageData,
} from "../../schema/index.ts";
import { normalizeForRepair } from "../../store/index.ts";
import { escapeReservedMarkers } from "./markers.ts";

export type BuildEpoch = Pick<RenderInput, "header" | "params" | "cache"> & {
  repair?: boolean;
};

/** Dropped from every replay (providers §3): the APIs reject empty text. */
function normalized(response: StoredResponse): StoredResponse | null {
  const parts = response.parts.filter((p) => p.kind !== "text" || p.text.trim() !== "");
  return parts.length === 0 ? null : { ...response, parts };
}

export type Lineage = { base: CompactionData | null; epochs: Set<number> };

/**
 * The epochs whose events make up epoch `epoch`'s transcript, and the compaction whose first message starts it. An undo
 * epoch continues the epoch it restored (context §6 "Undo"); the log is never rewritten, so that is a new epoch number.
 */
export function epochLineage(events: readonly EventEnvelope[], epoch: number): Lineage {
  const made = events.findLast((e) => e.type === "compaction" && CompactionData.parse(e.data).to === epoch);
  if (made === undefined) return { base: null, epochs: new Set([epoch]) };
  const c = CompactionData.parse(made.data);
  if (c.kind !== "undo" || c.restores === undefined) return { base: c, epochs: new Set([epoch]) };
  const before = epochLineage(events, c.restores);
  return { base: before.base, epochs: new Set([...before.epochs, epoch]) };
}

/** A repair epoch after a compaction continues from that compaction's lineage plus every epoch since. */
function repairLineage(events: readonly EventEnvelope[], epoch: number): Lineage {
  const roots = events.flatMap((e) => {
    if (e.type !== "compaction") return [];
    const to = CompactionData.parse(e.data).to;
    return to <= epoch ? [to] : [];
  });
  if (roots.length === 0) return { base: null, epochs: new Set() };
  const root = epochLineage(events, Math.max(...roots));
  const epochs = new Set(root.epochs);
  for (let n = Math.max(...root.epochs) + 1; n <= epoch; n++) epochs.add(n);
  return { base: root.base, epochs };
}

export function cancelledTurns(events: readonly EventEnvelope[]): Set<number> {
  const turns = new Set<number>();
  for (const e of events) {
    if (e.type === "turn.end" && e.turn !== null && TurnEndData.parse(e.data).reason === "cancelled") turns.add(e.turn);
  }
  return turns;
}

export function buildRequest(events: readonly EventEnvelope[], epoch: BuildEpoch): RenderInput {
  const cancelled = cancelledTurns(events);
  const items: TranscriptItem[] = [];
  let lastCalls = new Map<string, number>();
  const groupCalls = new Map<TranscriptItem, Map<string, number>>();
  let open: Extract<TranscriptItem, { kind: "user" }> | null = null;
  const openGroup = (): Part[] => {
    if (open === null) {
      open = { kind: "user", parts: [] };
      items.push(open);
      groupCalls.set(open, lastCalls);
    }
    return open.parts;
  };
  const isRepair =
    epoch.repair === true ||
    events.some(
      (e) =>
        e.type === "epoch.start" &&
        e.epoch === epoch.header.epoch &&
        (e.data as { reason?: string })?.reason === "repair",
    );
  const lineage = isRepair ? repairLineage(events, epoch.header.epoch) : epochLineage(events, epoch.header.epoch);
  // Before any compaction a repair epoch sees every earlier epoch; afterwards only its lineage.
  const inScope = (e: EventEnvelope): boolean =>
    isRepair && lineage.epochs.size === 0 ? e.epoch <= epoch.header.epoch : lineage.epochs.has(e.epoch);
  const pairedCallIds = new Set<string>();
  const latestEpochPerTurn = new Map<number, number>();
  if (isRepair) {
    for (const e of events) {
      if (e.turn !== null && inScope(e)) {
        const cur = latestEpochPerTurn.get(e.turn);
        if (cur === undefined || e.epoch > cur) latestEpochPerTurn.set(e.turn, e.epoch);
      }
      if (e.type === "tool.result") {
        try {
          pairedCallIds.add(ToolResultData.parse(e.data).callId);
        } catch {}
      }
    }
  }
  // The first message of a compacted epoch and the pending user message that follows it are one user message.
  let carried: Extract<TranscriptItem, { kind: "user" }> | null = null;
  if (lineage.base !== null) {
    carried = { kind: "user", parts: [{ kind: "text", text: lineage.base.firstMessage }] };
    items.push(carried);
  }
  for (const e of events) {
    if (!inScope(e) || (e.turn !== null && cancelled.has(e.turn))) continue;
    if (isRepair) {
      if (e.turn !== null && e.epoch !== latestEpochPerTurn.get(e.turn)) continue;
    }
    if (e.type === "user.message") {
      const part = { kind: "text", text: UserMessageData.parse(e.data).text } as const;
      if (carried !== null && items.at(-1) === carried) carried.parts.push(part);
      else items.push({ kind: "user", parts: [part] });
      open = null;
    } else if (e.type === "model.response") {
      const parsed = StoredResponse.parse(e.data);
      const response = isRepair ? normalizeForRepair(parsed, pairedCallIds) : normalized(parsed);
      if (response !== null) {
        const ids = response.parts.flatMap((p) => (p.kind === "tool_call" ? [p.id] : []));
        lastCalls = new Map(ids.map((id, i) => [id, i]));
        items.push({ kind: "assistant", stored: response });
      }
      open = null;
    } else if (e.type === "model.request") {
      open = null;
    } else if (e.type === "tool.result") {
      const r = ToolResultData.parse(e.data);
      openGroup().push({
        kind: "tool_result",
        callId: r.callId,
        isError: r.status !== "ok",
        content: [
          { kind: "text", text: escapeReservedMarkers(r.output) },
          ...(r.media ?? []).map(({ bytes: _bytes, ...part }) => part),
        ],
      });
    } else if (e.type === "system.injected") {
      const s = SystemInjectedData.parse(e.data);
      openGroup().push({ kind: "instruction", text: s.text, reason: s.reason });
    }
  }
  for (const item of items) {
    if (item.kind !== "user") continue;
    const order = groupCalls.get(item);
    const rank = (p: Part): number =>
      p.kind === "tool_result" ? (order?.get(p.callId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const results = item.parts.filter((p) => p.kind === "tool_result").sort((a, b) => rank(a) - rank(b));
    if (results.length > 0) item.parts = [...results, ...item.parts.filter((p) => p.kind !== "tool_result")];
  }
  return { ...epoch, transcript: items };
}
