// The event envelope, one JSONL line of the event log (event-log "Event envelope").
import { z } from "zod";
import { IsoTime, Ulid } from "./primitives.ts";

// `type` stays a string so a reader can report unknown types (event-log "Core vs optional events"); `data` per type comes with each event's first writer (QUESTIONS Q22).
export const EventEnvelope = z.object({
  v: z.literal(1),
  id: Ulid,
  ts: IsoTime,
  session: Ulid,
  epoch: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative().nullable(),
  type: z.string().min(1),
  core: z.boolean(),
  data: z.unknown(),
});

export type EventEnvelope = z.infer<typeof EventEnvelope>;
