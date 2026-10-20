// The image count and bytes budgets of one epoch's transcript (tools §1.6).
import { type EventEnvelope, ToolResultData, TurnEndData } from "../schema/index.ts";

/** Images and documents together may fill this share of the provider's request cap. */
export const MEDIA_BYTES_SHARE = 0.6;

export const base64Size = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export interface MediaBudget {
  /** Reserves one item of `bytes` before its `tool.result` is logged; returns the refusal text, or undefined when it fits. */
  claim(bytes: number): string | undefined;
  /** Forgets the reservations once the batch's results are in the log. */
  settle(): void;
}

export function createMediaBudget(
  events: readonly EventEnvelope[],
  epoch: () => number,
  caps: { requestCapBytes: number; maxImages: number | null },
): MediaBudget {
  let reserved = { count: 0, base64: 0 };
  const logged = (): { count: number; base64: number } => {
    const cancelled = new Set<number>();
    for (const e of events) {
      if (e.type === "turn.end" && e.turn !== null && TurnEndData.parse(e.data).reason === "cancelled")
        cancelled.add(e.turn);
    }
    const now = epoch();
    // A repair epoch resends the earlier epochs' turns (their latest epoch wins), as the transcript builder does.
    const repair = events.some(
      (e) => e.type === "epoch.start" && e.epoch === now && (e.data as { reason?: string })?.reason === "repair",
    );
    const latest = new Map<number, number>();
    if (repair) {
      for (const e of events) {
        if (e.turn !== null && e.epoch <= now) latest.set(e.turn, Math.max(latest.get(e.turn) ?? 0, e.epoch));
      }
    }
    const sent = (e: EventEnvelope): boolean =>
      e.epoch <= now &&
      !(e.turn !== null && cancelled.has(e.turn)) &&
      (repair && e.turn !== null ? e.epoch === latest.get(e.turn) : e.epoch === now);
    const total = { count: 0, base64: 0 };
    for (const e of events) {
      if (e.type !== "tool.result" || !sent(e)) continue;
      for (const m of ToolResultData.parse(e.data).media ?? []) {
        total.count += 1;
        total.base64 += base64Size(m.bytes);
      }
    }
    return total;
  };
  return {
    claim(bytes) {
      const used = logged();
      const count = used.count + reserved.count;
      if (caps.maxImages !== null && count >= caps.maxImages)
        return `Too many images in this conversation (${count}). Run /compact or start a new session to view more.`;
      const limit = caps.requestCapBytes * MEDIA_BYTES_SHARE;
      const base64 = used.base64 + reserved.base64;
      if (base64 + base64Size(bytes) > limit)
        return `Images and documents already take ${(base64 / 1e6).toFixed(1)} MB of the ${(limit / 1e6).toFixed(1)} MB a request may carry. Run /compact or start a new session to view more.`;
      reserved = { count: reserved.count + 1, base64: reserved.base64 + base64Size(bytes) };
      return undefined;
    },
    settle() {
      reserved = { count: 0, base64: 0 };
    },
  };
}
