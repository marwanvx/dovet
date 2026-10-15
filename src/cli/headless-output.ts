// Headless input and output (tui "Headless mode", cli-config "Piped input", interfaces §10).
import { z } from "zod";

export const STDIN_MAX_BYTES = 10 * 1024 * 1024;

export function combineStdinAndPrompt(input: {
  promptArg: string | undefined;
  stdinText: string | undefined;
  piped: boolean;
}): { prompt: string; stdinName?: string } | { error: string; exitCode: 2 } {
  const stdin = input.piped ? (input.stdinText ?? "") : "";
  if (Buffer.byteLength(stdin, "utf8") > STDIN_MAX_BYTES) {
    return { error: `stdin is over the 10 MB limit; pipe a smaller input`, exitCode: 2 };
  }
  if (input.promptArg !== undefined && input.promptArg !== "") {
    if (stdin !== "") {
      return { prompt: `<stdin>\n${stdin}\n</stdin>\n\n${input.promptArg}`, stdinName: "stdin" };
    }
    return { prompt: input.promptArg };
  }
  if (stdin !== "") return { prompt: stdin, stdinName: "stdin" };
  return { error: `no prompt given; pass one as an argument or pipe it on stdin`, exitCode: 2 };
}

export const HeadlessJson = z.strictObject({
  schema: z.literal("dovet.json/1"),
  result: z.string(),
  stopReason: z.string(),
  incomplete: z.boolean(),
  sessionId: z.string(),
  receipt: z.record(z.string(), z.json()),
  usage: z.record(z.string(), z.json()),
  cost: z.number().nullable(),
});

export type HeadlessJson = z.infer<typeof HeadlessJson>;

export const StreamJson = z.looseObject({
  schema: z.literal("dovet.stream/1"),
  type: z.string(),
});

export function formatJson(input: {
  result: string;
  stopReason: string;
  incomplete: boolean;
  sessionId: string;
  receipt: Record<string, unknown>;
  usage: Record<string, unknown>;
  cost: number | null;
}): string {
  const parsed = HeadlessJson.parse({
    schema: "dovet.json/1",
    result: input.result,
    stopReason: input.stopReason,
    incomplete: input.incomplete,
    sessionId: input.sessionId,
    receipt: input.receipt,
    usage: input.usage,
    cost: input.cost,
  });
  return `${JSON.stringify(parsed)}\n`;
}

function escapeStreamLine(line: string): string {
  return line.replaceAll(" ", "\\u2028").replaceAll(" ", "\\u2029");
}

export function formatStreamJson(events: readonly Record<string, unknown>[]): string {
  return events
    .map((e) => escapeStreamLine(JSON.stringify({ schema: "dovet.stream/1", ...e })))
    .map((l) => `${l}\n`)
    .join("");
}

export type HeadlessOutcome =
  | { kind: "ok"; incomplete?: boolean }
  | { kind: "usage" }
  | { kind: "guard" }
  | { kind: "budget" }
  | { kind: "refusal" }
  | { kind: "history-rejected" }
  | { kind: "error" }
  | { kind: "crash" }
  | { kind: "signal"; signal: "SIGINT" | "SIGHUP" | "SIGTERM" | "SIGBREAK" };

/** Exit codes (tui "Headless mode"): 0 success incl incomplete, 1 error, 2 usage, 3 guard, 4 budget, 5 refusal, 6 history, 70 crash, 129/130/143 signals. */
export function exitCodeFor(outcome: HeadlessOutcome): number {
  switch (outcome.kind) {
    case "ok":
      return 0;
    case "usage":
      return 2;
    case "guard":
      return 3;
    case "budget":
      return 4;
    case "refusal":
      return 5;
    case "history-rejected":
      return 6;
    case "crash":
      return 70;
    case "error":
      return 1;
    case "signal":
      if (outcome.signal === "SIGINT") return 130;
      if (outcome.signal === "SIGHUP") return 129;
      return 143;
  }
}
