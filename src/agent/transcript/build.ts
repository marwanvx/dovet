// The pure transcript builder (agent-loop "Determinism contract of the transcript builder").
import type { RenderInput, TranscriptItem } from "../../ai/index.ts";
import {
  type EventEnvelope,
  type Part,
  StoredResponse,
  SystemInjectedData,
  ToolResultData,
  TurnEndData,
  UserMessageData,
} from "../../schema/index.ts";
import { escapeReservedMarkers } from "./markers.ts";

export type BuildEpoch = Pick<RenderInput, "header" | "params" | "cache">;

/** Dropped from every replay (providers §3): the APIs reject empty text. */
function normalized(response: StoredResponse): StoredResponse | null {
  const parts = response.parts.filter((p) => p.kind !== "text" || p.text.trim() !== "");
  return parts.length === 0 ? null : { ...response, parts };
}

function cancelledTurns(events: readonly EventEnvelope[]): Set<number> {
  const turns = new Set<number>();
  for (const e of events) {
    if (e.type === "turn.end" && e.turn !== null && TurnEndData.parse(e.data).reason === "cancelled") turns.add(e.turn);
  }
  return turns;
}

export function buildRequest(events: readonly EventEnvelope[], epoch: BuildEpoch): RenderInput {
  const cancelled = cancelledTurns(events);
  const items: TranscriptItem[] = [];
  const callOrder = new Map<string, number>();
  let open: Extract<TranscriptItem, { kind: "user" }> | null = null;
  const openGroup = (): Part[] => {
    if (open === null) {
      open = { kind: "user", parts: [] };
      items.push(open);
    }
    return open.parts;
  };
  for (const e of events) {
    if (e.epoch !== epoch.header.epoch || (e.turn !== null && cancelled.has(e.turn))) continue;
    if (e.type === "user.message") {
      items.push({ kind: "user", parts: [{ kind: "text", text: UserMessageData.parse(e.data).text }] });
      open = null;
    } else if (e.type === "model.response") {
      const response = normalized(StoredResponse.parse(e.data));
      if (response !== null) {
        for (const p of response.parts) if (p.kind === "tool_call") callOrder.set(p.id, callOrder.size);
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
        content: [{ kind: "text", text: escapeReservedMarkers(r.output) }],
      });
    } else if (e.type === "system.injected") {
      const s = SystemInjectedData.parse(e.data);
      openGroup().push({ kind: "instruction", text: s.text, reason: s.reason });
    }
  }
  for (const item of items) {
    if (item.kind !== "user") continue;
    const rank = (p: Part): number =>
      p.kind === "tool_result" ? (callOrder.get(p.callId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const results = item.parts.filter((p) => p.kind === "tool_result").sort((a, b) => rank(a) - rank(b));
    if (results.length > 0) item.parts = [...results, ...item.parts.filter((p) => p.kind !== "tool_result")];
  }
  return { ...epoch, transcript: items };
}
