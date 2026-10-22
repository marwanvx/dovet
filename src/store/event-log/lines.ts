// One complete log line for a fork to append to the copy it has not opened yet.
import type { EventType } from "../../schema/index.ts";

export function eventLine(
  type: EventType,
  at: { session: string; epoch: number },
  data: unknown,
  deps: { ids: { ulid(): string }; clock: { now(): number } },
): string {
  return `${JSON.stringify({
    v: 1,
    id: deps.ids.ulid(),
    ts: new Date(deps.clock.now()).toISOString(),
    session: at.session,
    epoch: at.epoch,
    turn: null,
    type,
    core: true,
    data,
  })}\n`;
}
