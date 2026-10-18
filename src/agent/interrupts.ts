// Interrupt, queue, harness and signal decisions (agent-loop "Interrupts (Esc in the TUI, SIGINT in headless)", "Harness messages during a turn", "Process signals and crashes").
import type { BlobRef, DocumentPart, ImagePart, Part, StoredResponse } from "../schema/index.ts";
import { type ExecutedResult, INTERRUPTED_NOT_RUN, INTERRUPTED_TOOL_TEXT, type ParsedCall } from "./loop.ts";

export const INTERRUPT_INSTRUCTION =
  "The user interrupted your response. Blocks that finished are kept above; the rest was discarded.";
export const SILENCE_REMINDER_TEXT =
  "The user hasn't heard from you in a while — say in a few words what you're doing, then continue.";
export const DOUBLE_PRESS_MS = 1000;
export const SILENCE_AFTER_STEPS = 5;
export const SILENCE_MAX_PER_TURN = 2;
export const OPEN_TASKS_MAX_CONTINUATIONS = 2;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;
export const EXIT_SIGHUP = 129;
export const EXIT_CRASH = 70;
export const PROMPT_INTERRUPTED_REASON = "deny (interrupted)";

export type InterruptState = "PREPARE" | "REQUEST" | "STREAM" | "TOOLS" | "PROMPT";

export function cancelBeforeOutput(): {
  endReason: "cancelled";
  excludeFromTranscript: true;
  restoreToInputBox: true;
} {
  return { endReason: "cancelled", excludeFromTranscript: true, restoreToInputBox: true };
}

export function shouldAppendInterrupted(completed: StoredResponse | null): boolean {
  if (completed === null) return false;
  return completed.parts.some((p) => (p.kind === "text" && p.text.trim() !== "") || p.kind === "tool_call");
}

export function streamInterruptResults(calls: readonly ParsedCall[]): ExecutedResult[] {
  return calls.map((c) => ({
    callId: c.id,
    name: c.name,
    output: { status: "interrupted" as const, content: [{ kind: "text" as const, text: INTERRUPTED_NOT_RUN }] },
    invalid: false,
  }));
}

export function mergeToolsInterrupt(
  finished: readonly ExecutedResult[],
  pending: readonly ParsedCall[],
): ExecutedResult[] {
  const seen = new Set(finished.map((r) => r.callId));
  const interrupted = pending
    .filter((c) => !seen.has(c.id))
    .map((c) => ({
      callId: c.id,
      name: c.name,
      output: { status: "interrupted" as const, content: [{ kind: "text" as const, text: INTERRUPTED_TOOL_TEXT }] },
      invalid: false,
    }));
  return [...finished, ...interrupted];
}

export function ignoresRepeatInterrupt(lastMs: number, nowMs: number): boolean {
  return nowMs - lastMs < DOUBLE_PRESS_MS;
}

export function secondPressExits(lastMs: number, nowMs: number): boolean {
  return nowMs - lastMs < DOUBLE_PRESS_MS;
}

export type QueuedAttachment = ImagePart | DocumentPart;
export type QueuedMessage = { text: string; attachments: readonly QueuedAttachment[] };

/** A submitted attachment as the schema parses it: stored blobs ride along, bare paths can't (M1 keeps the blob store). */
export type AttachmentInput = { kind: "image" | "file"; path?: string | undefined; blob?: BlobRef | undefined };

const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImagePart["mediaType"]>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Converts a submit's attachments to parts a queued message can carry; anything else warns instead of vanishing. */
export function attachmentParts(attachments: readonly AttachmentInput[]): {
  parts: QueuedAttachment[];
  notices: string[];
} {
  const parts: QueuedAttachment[] = [];
  const notices: string[] = [];
  for (const a of attachments) {
    const name = a.path ?? "(unnamed)";
    if (a.blob === undefined) {
      notices.push(
        `Attachment "${name}" was not attached (only stored files ride with a queued message); the message text still queued.`,
      );
      continue;
    }
    const extension = (a.path ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    const imageType = extension === undefined ? undefined : IMAGE_MEDIA_TYPES[extension];
    if (a.kind === "image" && imageType !== undefined) {
      parts.push({ kind: "image", blob: a.blob, mediaType: imageType });
    } else if (a.kind === "file" && extension === "pdf") {
      parts.push({ kind: "document", blob: a.blob, mediaType: "application/pdf" });
    } else {
      notices.push(`Attachment "${name}" was not attached (unsupported file type); the message text still queued.`);
    }
  }
  return { parts, notices };
}

export class InputQueue {
  private items: QueuedMessage[] = [];

  get size(): number {
    return this.items.length;
  }

  get label(): string {
    return `queued (${this.items.length})`;
  }

  queue(message: QueuedMessage): void {
    this.items.push(message);
  }

  peekAll(): readonly QueuedMessage[] {
    return [...this.items];
  }

  takeAll(): QueuedMessage[] {
    const out = [...this.items];
    this.items = [];
    return out;
  }

  pullBackForEdit(): QueuedMessage[] {
    return this.takeAll();
  }
}

export function queuedTextParts(queued: readonly QueuedMessage[]): Part[] {
  return queued.flatMap((m) => [
    ...(m.text === "" ? [] : [{ kind: "text", text: m.text } satisfies Part]),
    ...m.attachments,
  ]);
}

export function attachQueuedAfterResults(results: readonly Part[], queued: readonly QueuedMessage[]): Part[] {
  return [...results, ...queuedTextParts(queued)];
}

export function queuedAsNextMessage(queued: readonly QueuedMessage[]): Part[] {
  return queuedTextParts(queued);
}

export function queuedDisposition(mode: "interactive" | "headless"): "input-box" | "next-turn" {
  return mode === "interactive" ? "input-box" : "next-turn";
}

export function startsNextTurnImmediately(endReason: string, hasQueued: boolean): boolean {
  return endReason === "end_turn" && hasQueued;
}

export function ctrlEnterOutcome(): { interrupt: true; keepCompleted: true; deliverImmediately: true } {
  return { interrupt: true, keepCompleted: true, deliverImmediately: true };
}

export class SilenceTracker {
  private silent = 0;
  private reminders = 0;

  noteStep(hasReadable: boolean): { text: string; reason: "silence-reminder" } | null {
    if (hasReadable) {
      this.silent = 0;
      return null;
    }
    this.silent += 1;
    if (this.silent >= SILENCE_AFTER_STEPS && this.reminders < SILENCE_MAX_PER_TURN) {
      this.reminders += 1;
      this.silent = 0;
      return { text: SILENCE_REMINDER_TEXT, reason: "silence-reminder" };
    }
    return null;
  }

  resetTurn(): void {
    this.silent = 0;
    this.reminders = 0;
  }
}

export function shouldContinueForOpenTasks(input: {
  headless: boolean;
  endedWithText: boolean;
  openItems: number;
  blockerStated: boolean;
  continuations: number;
}): boolean {
  if (!input.headless || !input.endedWithText || input.blockerStated || input.openItems <= 0) return false;
  return input.continuations < OPEN_TASKS_MAX_CONTINUATIONS;
}

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK";

export function exitCodeForSignal(signal: StopSignal): number {
  if (signal === "SIGINT") return EXIT_SIGINT;
  if (signal === "SIGHUP") return EXIT_SIGHUP;
  return EXIT_SIGTERM;
}

export function secondSignalExits(lastMs: number, nowMs: number): boolean {
  return nowMs - lastMs < DOUBLE_PRESS_MS;
}

export function sigintOutcome(input: {
  first: boolean;
  withinWindow: boolean;
}): { action: "interrupt" } | { action: "exit"; exitCode: 130 } {
  if (!input.first && input.withinWindow) return { action: "exit", exitCode: EXIT_SIGINT };
  return { action: "interrupt" };
}

export function shutdownPlan(signal: "SIGTERM" | "SIGHUP" | "SIGBREAK"): {
  killChildTrees: true;
  flushAndFsyncLog: true;
  releaseLock: true;
  writeSyntheticResults: false;
  exitCode: number;
} {
  return {
    killChildTrees: true,
    flushAndFsyncLog: true,
    releaseLock: true,
    writeSyntheticResults: false,
    exitCode: signal === "SIGHUP" ? EXIT_SIGHUP : EXIT_SIGTERM,
  };
}

export function mustRestoreTerminalFirst(event: "SIGTSTP" | "SIGCONT" | "crash"): boolean {
  return event === "SIGTSTP" || event === "crash";
}

export function toolsKeepRunningOnTstp(): true {
  return true;
}

export function buildCrashReport(input: {
  stack: string;
  versions: Record<string, string>;
  eventTypes: readonly string[];
  nowMs?: number;
}): { filename: string; text: string } {
  const types = input.eventTypes.slice(-50);
  const text = JSON.stringify({ stack: input.stack, versions: input.versions, eventTypes: types });
  const stamp = new Date(input.nowMs ?? Date.now()).toISOString().replaceAll(/[:.]/g, "-");
  return { filename: `crash-${stamp}.json`, text };
}
