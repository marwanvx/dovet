// The v0.1 event types and whether each is core (event-log "Event types (v0.1)" and "Core vs optional events").
const CORE = [
  "session.start",
  "session.resume",
  "session.fork",
  "session.end",
  "epoch.start",
  "user.message",
  "model.request",
  "model.response",
  "model.error",
  "tool.call",
  "tool.result",
  "permission.request",
  "permission.decision",
  "file.change",
  "checkpoint",
  "compaction",
  "system.injected",
  "taint.change",
  "user.shell",
  "budget.event",
  "settings.change",
  "plan.presented",
  "plan.decision",
] as const;
const OPTIONAL = ["receipt", "instructions.loaded", "shell.snapshot", "turn.end"] as const;

export type EventType = (typeof CORE)[number] | (typeof OPTIONAL)[number];

export const EVENT_TYPES: ReadonlyMap<string, { core: boolean }> = new Map<string, { core: boolean }>([
  ...CORE.map((t): [string, { core: boolean }] => [t, { core: true }]),
  ...OPTIONAL.map((t): [string, { core: boolean }] => [t, { core: false }]),
]);
