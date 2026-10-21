// Agent turn loop (agent-loop "Turn state machine", "Stop-reason handling", "Tool execution within a turn", "Loop and runaway protection").

import type { ProviderErrorInfo, ProviderRequest, StopReason } from "../ai/index.ts";
import { BILLED_REFUSAL_CATEGORIES } from "../ai/index.ts";
import type { ShellChoice } from "../platform/index.ts";
import type { Env, NamedSecret, RuleContext, RuleSet, ShellParsers } from "../policy/index.ts";
import { redactText, ruleSetFromSettings } from "../policy/index.ts";
import type { EventEnvelope, PrefixFingerprint, StoredResponse } from "../schema/index.ts";
import type { LoadedSettings } from "../store/index.ts";
import { findProjectRoot, isHistoryRelated, REPAIR_HINT } from "../store/index.ts";
import type { ShellSnapshot, ToolContext, ToolDefinition, ToolOutput, ToolRegistry } from "../tools/index.ts";
import {
  buildReadResultsIndex,
  createBashTool,
  INTERRUPTED_TOOL_TEXT,
  limitOutput,
  stripHidden,
} from "../tools/index.ts";

export { INTERRUPTED_TOOL_TEXT } from "../tools/index.ts";

import { cacheWarning, prefixFingerprint } from "./transcript/index.ts";

export type LoopState = "IDLE" | "PREPARE" | "REQUEST" | "STREAM" | "TOOLS" | "FINALIZE" | "INTERRUPTING";

export const MAX_REQUESTS_PER_TURN = 150;
export const MAX_PARALLEL = 8;
export const NO_PROGRESS_LIMIT = 25;
export const MALFORMED_LIMIT = 3;
export const IDENTICAL_FAIL_LIMIT = 3;
export const MAX_PAUSE_CONTINUATIONS = 5;
export const REQUEST_CAP_BYTES = 32 * 1024 * 1024;
export const REQUEST_GUARD_RATIO = 0.9;

const REQUEST_CAPS: Readonly<Record<string, number>> = {
  bedrock: 16 * 1024 * 1024,
  vertex: 16 * 1024 * 1024,
};

export function requestCapFor(provider: string): number {
  return REQUEST_CAPS[provider] ?? REQUEST_CAP_BYTES;
}

export function shouldDiscardEarly(stop: StopReason, hasToolCalls: boolean): boolean {
  if (stop === "refusal") return true;
  if (stop === "max_tokens" && hasToolCalls) return true;
  return false;
}

export function isOverCap(nextBytes: number, capBytes: number): boolean {
  return nextBytes > capBytes * REQUEST_GUARD_RATIO;
}

export function sizeGuardText(bytes: number): string {
  return `Tool result (${bytes} bytes) would push the next request past 90% of the provider's request cap; retry with a smaller read or /compact.`;
}

const EARLY_TOOLS = new Set(["Read", "Grep", "Glob"]);

export function isEarlyEligible(toolName: string, behavior: string): boolean {
  return EARLY_TOOLS.has(toolName) && behavior === "allow";
}

export function partitionCalls(calls: readonly { parallelSafe: boolean }[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  const flush = (): void => {
    if (current.length > 0) batches.push(current);
    current = [];
  };
  for (let i = 0; i < calls.length; i++) {
    const safe = calls[i]?.parallelSafe ?? false;
    if (!safe) {
      flush();
      batches.push([i]);
      continue;
    }
    current.push(i);
    if (current.length >= MAX_PARALLEL) flush();
  }
  flush();
  return batches;
}

export type StopInput = {
  stop: StopReason;
  toolCalls: number;
  hasText: boolean;
  emptyOrThinkingOnly: boolean;
  truncatedToolCall: boolean;
  refusalCategory?: string;
  refusalBeforeOutput?: boolean;
  pauseContinuations: number;
  emptyRetries: number;
  refusalRetries: number;
};

export type StopAction =
  | { kind: "tools" }
  | { kind: "finalize"; reason: string; note?: string }
  | { kind: "prepare"; instruction: string }
  | { kind: "retry" }
  | { kind: "compact-retry" }
  | { kind: "pause-continue" };

export const TRUNCATED_INSTRUCTION =
  "Your previous response was cut off at the output limit while writing a tool call. Retry with a smaller step.";

export function decideStopAction(input: StopInput): StopAction {
  if (input.emptyOrThinkingOnly) {
    if (input.emptyRetries < 1) return { kind: "retry" };
    return { kind: "finalize", reason: "end_turn", note: "The model returned no answer." };
  }
  if (input.refusalBeforeOutput === true && input.refusalCategory !== undefined) {
    if (!BILLED_REFUSAL_CATEGORIES.has(input.refusalCategory) && input.refusalRetries < 1) return { kind: "retry" };
    return { kind: "finalize", reason: "refusal" };
  }
  const stop = input.stop;
  if (stop === "end_turn") return { kind: "finalize", reason: "end_turn" };
  if (stop === "tool_use") return { kind: "tools" };
  if (stop === "max_tokens") {
    if (input.truncatedToolCall || input.toolCalls > 0) return { kind: "prepare", instruction: TRUNCATED_INSTRUCTION };
    return { kind: "finalize", reason: "end_turn", note: "response truncated at output limit" };
  }
  if (stop === "context_exceeded") return { kind: "compact-retry" };
  if (stop === "refusal") return { kind: "finalize", reason: "refusal" };
  if (stop === "pause") {
    if (input.pauseContinuations < MAX_PAUSE_CONTINUATIONS) return { kind: "pause-continue" };
    return { kind: "finalize", reason: "end_turn", note: "pause continuation limit reached" };
  }
  if (stop === "stop_sequence" || typeof stop === "object") {
    const raw = typeof stop === "object" ? stop.other : stop;
    return { kind: "finalize", reason: "end_turn", note: `raw stop reason: ${raw}` };
  }
  return { kind: "finalize", reason: "end_turn" };
}

export function malformedPauseMessage(model: string, lastError: string, allTruncated: boolean): string {
  if (allTruncated)
    return `\`${model}\` sent broken tool calls 3 times in a row (last error: \`${lastError}\`). Every call was cut off by the output limit; raise the limit or ask for smaller steps. Continue?`;
  return `\`${model}\` sent broken tool calls 3 times in a row (last error: \`${lastError}\`). This model may not handle tool calls reliably; try a larger model with \`/model\`. Continue?`;
}

export function isDoomedRepeat(
  lastBody: string | undefined,
  lastRetryable: boolean | undefined,
  nextBody: string,
): boolean {
  return lastBody !== undefined && lastRetryable === false && lastBody === nextBody;
}

export function checkPairing(callIds: readonly string[], resultIds: readonly string[]): string | null {
  if (callIds.length !== resultIds.length)
    return `expected ${callIds.length} tool_result parts, got ${resultIds.length}`;
  for (let i = 0; i < callIds.length; i++) {
    if (callIds[i] !== resultIds[i]) return `tool_result order mismatch at ${i}: ${resultIds[i]} is not ${callIds[i]}`;
  }
  return null;
}

/** The transcript-level invariant (agent-loop "Stop-reason handling"): every assistant turn with tool calls is
 * followed by exactly those `tool_result` parts, in emitted order. A violation is an InvariantViolation. */
export function checkTranscriptPairing(
  items: readonly { kind: string; parts?: readonly unknown[]; stored?: { parts: readonly unknown[] } }[],
): string | null {
  const field = (p: unknown, key: "id" | "callId"): string | undefined => {
    if (typeof p !== "object" || p === null) return undefined;
    const value = (p as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  };
  const kindOf = (p: unknown): unknown =>
    typeof p === "object" && p !== null ? (p as Record<string, unknown>).kind : undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item?.kind !== "assistant") continue;
    const callIds = (item.stored?.parts ?? []).flatMap((p) => {
      const id = kindOf(p) === "tool_call" ? field(p, "id") : undefined;
      return id === undefined ? [] : [id];
    });
    if (callIds.length === 0) continue;
    const next = items[i + 1];
    const resultIds =
      next?.kind === "user"
        ? (next.parts ?? []).flatMap((p) => {
            const callId = kindOf(p) === "tool_result" ? field(p, "callId") : undefined;
            return callId === undefined ? [] : [callId];
          })
        : [];
    const issue = checkPairing(callIds, resultIds);
    if (issue !== null) return `tool_use/tool_result pairing: ${issue}`;
  }
  return null;
}

export type GuardPause =
  | { guard: "max-requests"; message: string }
  | { guard: "identical-failing"; message: string }
  | { guard: "no-progress"; message: string }
  | { guard: "malformed"; message: string }
  | { guard: "budget"; message: string }
  | { guard: "compaction-thrash"; message: string };

export class GuardTracker {
  requests = 0;
  cost = 0;
  malformedRounds = 0;
  lastMalformedError = "";
  malformedAllTruncated = false;
  identicalKey: string | undefined = undefined;
  identicalCount = 0;
  identicalError = "";
  noProgress = 0;
  lastBody: string | undefined = undefined;
  lastRetryable: boolean | undefined = undefined;
  compactions = 0;

  beforeRequest(
    body: string,
    budgetStops: boolean,
    maxRequests: number = MAX_REQUESTS_PER_TURN,
  ): { doomed: boolean } | { pause: GuardPause } {
    if (isDoomedRepeat(this.lastBody, this.lastRetryable, body)) return { doomed: true };
    if (budgetStops) return { pause: { guard: "budget", message: "Budget stops the turn before the next request." } };
    if (this.requests >= maxRequests)
      return {
        pause: {
          guard: "max-requests",
          message: `The agent has made ${maxRequests} requests this turn (cost $${this.cost.toFixed(2)}). Continue?`,
        },
      };
    return { doomed: false };
  }

  noteRequestSent(body: string): void {
    this.lastBody = body;
    this.requests += 1;
  }

  noteError(retryable: boolean): void {
    this.lastRetryable = retryable;
  }

  noteMalformedRound(allInvalid: boolean, lastError: string, allTruncated: boolean, model: string): GuardPause | null {
    if (!allInvalid) {
      this.malformedRounds = 0;
      this.malformedAllTruncated = false;
      return null;
    }
    this.malformedRounds += 1;
    this.lastMalformedError = lastError;
    this.malformedAllTruncated = this.malformedRounds === 1 ? allTruncated : this.malformedAllTruncated && allTruncated;
    if (this.malformedRounds >= MALFORMED_LIMIT)
      return { guard: "malformed", message: malformedPauseMessage(model, lastError, this.malformedAllTruncated) };
    return null;
  }

  noteIdenticalFail(key: string, error: string): GuardPause | null {
    if (key === this.identicalKey) this.identicalCount += 1;
    else {
      this.identicalKey = key;
      this.identicalCount = 1;
    }
    this.identicalError = error;
    if (this.identicalCount >= IDENTICAL_FAIL_LIMIT)
      return { guard: "identical-failing", message: `The call ${key} failed 3 times in a row (${error}). Continue?` };
    return null;
  }

  noteIdenticalSuccess(): void {
    this.identicalKey = undefined;
    this.identicalCount = 0;
  }

  noteProgress(madeProgress: boolean): GuardPause | null {
    this.noProgress = madeProgress ? 0 : this.noProgress + 1;
    if (this.noProgress >= NO_PROGRESS_LIMIT)
      return {
        guard: "no-progress",
        message: "25 requests with no file change, no new file read and no new command. Continue?",
      };
    return null;
  }

  noteCompaction(atThreshold: boolean): GuardPause | null {
    this.compactions = atThreshold ? this.compactions + 1 : 0;
    if (this.compactions >= 3)
      return {
        guard: "compaction-thrash",
        message:
          "Context is back at the threshold after 3 compactions in a row. Free context with /compact or a smaller scope.",
      };
    return null;
  }

  resetMalformed(): void {
    this.malformedRounds = 0;
  }

  resetForContinue(): void {
    this.requests = 0;
    this.malformedRounds = 0;
    this.identicalCount = 0;
    this.noProgress = 0;
    this.compactions = 0;
  }
}

export type ParsedCall = { id: string; name: string; rawJson: string };

export function parseToolCalls(parts: StoredResponse["parts"]): ParsedCall[] {
  return parts.flatMap((p) => (p.kind === "tool_call" ? [{ id: p.id, name: p.name, rawJson: p.inputJson }] : []));
}

function strictParseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, message: `INVALID_JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type DecideFn = (name: string, input: unknown) => { behavior: "allow" | "ask" | "deny"; reason: string };

export type PromptAnswer = {
  allow: boolean;
  dontAskAgain: boolean;
  comment?: string;
  dismissed?: boolean;
};

export type ExecuteToolsDeps = {
  registry: ToolRegistry;
  decide: DecideFn;
  prompt: (call: { id: string; name: string; input: unknown }) => Promise<PromptAnswer>;
  run: (tool: ToolDefinition<unknown>, input: unknown, ctx: ToolContext) => Promise<ToolOutput>;
  makeContext: () => ToolContext;
  offloadDir: string;
  capBytes?: number;
  headless?: boolean;
  /** Caller omits these when the response ends in refusal, max_tokens with tool calls, or interrupt (see shouldDiscardEarly). */
  earlyResults?: ReadonlyMap<string, ToolOutput>;
  signal?: AbortSignal;
  /** Secret values that never reach the model or the log (permissions §8); key formats are always redacted. */
  secrets?: () => readonly NamedSecret[];
  /** Re-stat hook run before each batch that executes (cli-config "Live settings reload");
   * the caller decides what a change re-applies (rules, context, events). */
  beforeBatch?: () => Promise<void>;
  onResult?: (result: ExecutedResult) => void;
};

export type ExecutedResult = { callId: string; name: string; output: ToolOutput; invalid: boolean };

export const NOT_RUN_STOPPED = "Not run: the user stopped this turn";
export const TRUNCATED_NOT_RUN = "Not run: the response was cut off at the output limit.";
export const REFUSAL_NOT_RUN = "Not run: the model refused this turn.";
export const ENDED_NOT_RUN = "Not run: the model ended its turn.";
export const UNKNOWN_TOOL_PREFIX = "Unknown tool";

function normalizeKey(name: string, input: unknown): string {
  return `${name}(${JSON.stringify(input) ?? "null"})`;
}

/** The output guard (permissions §8, §10): hidden-instruction characters are stripped (tainting the
 * session) and secrets redacted before a tool result reaches the model or the log. */
function guardOutput(output: ToolOutput, toolName: string, secrets: readonly NamedSecret[]): ToolOutput {
  let hidden = 0;
  const content = output.content.map((c) => {
    if (c.kind !== "text") return c;
    const stripped = stripHidden(c.text);
    hidden += stripped.removed;
    return { ...c, text: redactText(stripped.text, secrets) };
  });
  if (hidden === 0) return { ...output, content };
  const notice = `[${hidden} hidden characters were removed from this result.]`;
  const last = content.findLastIndex((c) => c.kind === "text");
  const noted =
    last < 0
      ? content
      : content.map((c, i) => (i === last && c.kind === "text" ? { ...c, text: `${c.text}\n${notice}` } : c));
  return {
    ...output,
    content: noted,
    meta: {
      ...output.meta,
      effects: [...(output.meta?.effects ?? []), { kind: "taint" as const, source: `${toolName} result` }],
    },
  };
}

export async function executeTools(
  calls: ParsedCall[],
  deps: ExecuteToolsDeps,
): Promise<{
  results: ExecutedResult[];
  stopped: boolean;
  prompted: number;
}> {
  const prepared = calls.map((call) => {
    const parsed = strictParseJson(call.rawJson);
    if (!parsed.ok) return { call, invalid: parsed.message as string, input: undefined };
    const prep = deps.registry.prepare(call.name, parsed.value);
    if (!prep.ok) {
      if (deps.decide !== undefined) {
        const decision = deps.decide(call.name, parsed.ok ? parsed.value : {});
        if (decision.behavior === "deny") {
          return { call, invalid: `Permission denied: ${decision.reason}`, input: undefined, unknown: false };
        }
      }
      const unknown = prep.message.startsWith(UNKNOWN_TOOL_PREFIX);
      return { call, invalid: prep.message, input: undefined, unknown };
    }
    if (prep.ok) return { call, invalid: undefined as string | undefined, input: prep.input, tool: prep.tool };
    return { call, invalid: "invalid", input: undefined };
  });

  const secrets = deps.secrets?.() ?? [];
  const results = new Map<string, ExecutedResult>();
  const setResult = (id: string, result: ExecutedResult): void => {
    const guarded = { ...result, output: guardOutput(result.output, result.name, secrets) };
    results.set(id, guarded);
    deps.onResult?.(guarded);
  };
  for (const p of prepared) {
    if (p.invalid !== undefined) {
      setResult(p.call.id, {
        callId: p.call.id,
        name: p.call.name,
        output: { status: "error", content: [{ kind: "text", text: p.invalid }] },
        invalid: true,
      });
    }
  }
  const valid = prepared.filter((p) => p.invalid === undefined) as Array<{
    call: ParsedCall;
    input: unknown;
    tool: ToolDefinition<unknown>;
  }>;
  const batches = partitionCalls(valid.map((v) => ({ parallelSafe: v.tool.parallelSafe })));
  let stopped = false;
  let prompted = 0;

  const capBytes = deps.capBytes ?? REQUEST_CAP_BYTES;

  const applySizeGuard = (text: string): string => {
    const bytes = Buffer.byteLength(text, "utf8");
    return bytes > capBytes * REQUEST_GUARD_RATIO ? sizeGuardText(bytes) : text;
  };

  const finalizeOutput = async (
    raw: ToolOutput,
    tool: ToolDefinition<unknown>,
    callId: string,
    name: string,
  ): Promise<ToolOutput> => {
    const guarded = guardOutput(raw, name, secrets);
    let text = guarded.content.map((c) => (c.kind === "text" ? c.text : "")).join("");
    const capped = applySizeGuard(text);
    if (capped !== text) {
      return {
        status: "error",
        content: [{ kind: "text", text: capped }],
        ...(guarded.meta === undefined ? {} : { meta: guarded.meta }),
      };
    }
    if (text.length > 30_000 && tool.limitsOwnOutput !== true) {
      const limited = await limitOutput(text, { dir: deps.offloadDir, id: callId.replace(/[^A-Za-z0-9_-]/g, "_") });
      text = limited.text;
      return {
        ...guarded,
        content: [{ kind: "text", text }],
        ...(limited.offloadPath === undefined ? {} : { meta: { ...guarded.meta, offloadPath: limited.offloadPath } }),
      };
    }
    return guarded;
  };

  const finishOne = async (
    tool: ToolDefinition<unknown>,
    input: unknown,
    callId: string,
    name: string,
  ): Promise<ToolOutput> => {
    if (deps.signal?.aborted === true)
      return { status: "interrupted", content: [{ kind: "text", text: INTERRUPTED_TOOL_TEXT }] };
    const early = deps.earlyResults?.get(callId);
    if (early !== undefined) return finalizeOutput(early, tool, callId, name);
    let out: ToolOutput;
    try {
      out = await deps.run(tool, input, deps.makeContext());
    } catch (err) {
      out = { status: "error", content: [{ kind: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
    return finalizeOutput(out, tool, callId, name);
  };

  for (const batch of batches) {
    if (stopped) {
      for (const idx of batch) {
        const v = valid[idx];
        if (v === undefined || results.has(v.call.id)) continue;
        setResult(v.call.id, {
          callId: v.call.id,
          name: v.call.name,
          output: { status: "error", content: [{ kind: "text", text: NOT_RUN_STOPPED }] },
          invalid: false,
        });
      }
      continue;
    }
    const items = batch.map((idx) => valid[idx]).filter((v) => v !== undefined);
    const pending = items.filter((v) => !results.has(v.call.id));
    if (pending.length === 0) continue;
    await deps.beforeBatch?.();
    const alone = pending.length === 1 && pending[0]?.tool.parallelSafe !== true;
    if (alone) {
      const v = pending[0];
      if (v === undefined) continue;
      const decision = deps.decide(v.call.name, v.input);
      if (decision.behavior === "allow") {
        const out = await finishOne(v.tool, v.input, v.call.id, v.call.name);
        setResult(v.call.id, { callId: v.call.id, name: v.call.name, output: out, invalid: false });
      } else if (decision.behavior === "deny") {
        setResult(v.call.id, {
          callId: v.call.id,
          name: v.call.name,
          output: { status: "error", content: [{ kind: "text", text: `Permission denied: ${decision.reason}` }] },
          invalid: false,
        });
      } else {
        if (deps.headless === true) {
          setResult(v.call.id, {
            callId: v.call.id,
            name: v.call.name,
            output: { status: "error", content: [{ kind: "text", text: `Permission denied: ${decision.reason}` }] },
            invalid: false,
          });
        } else {
          prompted += 1;
          const answer = await deps.prompt({ id: v.call.id, name: v.call.name, input: v.input });
          if (answer.dismissed === true || (answer.allow === false && answer.comment === undefined)) {
            setResult(v.call.id, {
              callId: v.call.id,
              name: v.call.name,
              output: { status: "error", content: [{ kind: "text", text: NOT_RUN_STOPPED }] },
              invalid: false,
            });
            stopped = true;
          } else if (answer.allow) {
            const out = await finishOne(v.tool, v.input, v.call.id, v.call.name);
            setResult(v.call.id, { callId: v.call.id, name: v.call.name, output: out, invalid: false });
          } else {
            setResult(v.call.id, {
              callId: v.call.id,
              name: v.call.name,
              output: {
                status: "error",
                content: [{ kind: "text", text: `Permission denied: ${answer.comment ?? decision.reason}` }],
              },
              invalid: false,
            });
          }
        }
      }
      continue;
    }
    const allowNow: typeof pending = [];
    const askQueue: typeof pending = [];
    for (const v of pending) {
      const decision = deps.decide(v.call.name, v.input);
      if (decision.behavior === "allow") allowNow.push(v);
      else if (decision.behavior === "deny")
        setResult(v.call.id, {
          callId: v.call.id,
          name: v.call.name,
          output: { status: "error", content: [{ kind: "text", text: `Permission denied: ${decision.reason}` }] },
          invalid: false,
        });
      else askQueue.push(v);
    }
    const running = new Map<string, Promise<ToolOutput>>();
    for (const v of allowNow) running.set(v.call.id, finishOne(v.tool, v.input, v.call.id, v.call.name));
    for (const v of askQueue) {
      if (results.has(v.call.id) || running.has(v.call.id)) continue;
      if (stopped) {
        setResult(v.call.id, {
          callId: v.call.id,
          name: v.call.name,
          output: { status: "error", content: [{ kind: "text", text: NOT_RUN_STOPPED }] },
          invalid: false,
        });
        continue;
      }
      if (deps.headless === true) {
        setResult(v.call.id, {
          callId: v.call.id,
          name: v.call.name,
          output: { status: "error", content: [{ kind: "text", text: "Permission denied (headless never prompts)" }] },
          invalid: false,
        });
        continue;
      }
      prompted += 1;
      const answer = await deps.prompt({ id: v.call.id, name: v.call.name, input: v.input });
      if (answer.dismissed === true || (answer.allow === false && answer.comment === undefined)) {
        setResult(v.call.id, {
          callId: v.call.id,
          name: v.call.name,
          output: { status: "error", content: [{ kind: "text", text: NOT_RUN_STOPPED }] },
          invalid: false,
        });
        stopped = true;
        continue;
      }
      if (answer.allow) {
        const re = deps.decide(v.call.name, v.input);
        if (re.behavior === "allow") running.set(v.call.id, finishOne(v.tool, v.input, v.call.id, v.call.name));
        else
          setResult(v.call.id, {
            callId: v.call.id,
            name: v.call.name,
            output: { status: "error", content: [{ kind: "text", text: `Permission denied: ${re.reason}` }] },
            invalid: false,
          });
      } else {
        setResult(v.call.id, {
          callId: v.call.id,
          name: v.call.name,
          output: {
            status: "error",
            content: [{ kind: "text", text: `Permission denied: ${answer.comment ?? "denied"}` }],
          },
          invalid: false,
        });
      }
      for (const rest of askQueue) {
        if (rest.call.id === v.call.id || results.has(rest.call.id) || running.has(rest.call.id)) continue;
        const re = deps.decide(rest.call.name, rest.input);
        if (
          re.behavior === "allow" &&
          answer.allow &&
          answer.dontAskAgain &&
          normalizeKey(v.call.name, v.input) === normalizeKey(rest.call.name, rest.input)
        ) {
          running.set(rest.call.id, finishOne(rest.tool, rest.input, rest.call.id, rest.call.name));
        }
      }
    }
    const settled = await Promise.all([...running].map(async ([id, p]) => ({ id, out: await p })));
    for (const { id, out } of settled) {
      const v = pending.find((p) => p.call.id === id);
      if (v !== undefined) setResult(id, { callId: id, name: v.call.name, output: out, invalid: false });
    }
  }

  const ordered = calls.map((c) => results.get(c.id)).filter((r): r is ExecutedResult => r !== undefined);
  return { results: ordered, stopped, prompted };
}

export function modelRequestBody(call: { messages: unknown; tools: unknown }): string {
  return JSON.stringify({ messages: call.messages, tools: call.tools });
}

export function modelRequestData(input: {
  provider: string;
  model: string;
  effort?: string;
  maxTokens: number;
  messageCount: number;
  body: string;
  fingerprint: PrefixFingerprint;
}): {
  provider: string;
  model: string;
  params: { effort?: string; maxTokens: number };
  messageCount: number;
  bodySha256: string;
  fingerprint: PrefixFingerprint;
} {
  return {
    provider: input.provider,
    model: input.model,
    params:
      input.effort === undefined
        ? { maxTokens: input.maxTokens }
        : { effort: input.effort, maxTokens: input.maxTokens },
    messageCount: input.messageCount,
    bodySha256: new Bun.CryptoHasher("sha256").update(input.body).digest("hex"),
    fingerprint: input.fingerprint,
  };
}

export function renderBodySha256(request: ProviderRequest): string {
  return request.bodySha256;
}

export function fingerprintOf(call: Parameters<typeof prefixFingerprint>[0]): PrefixFingerprint {
  return prefixFingerprint(call);
}

export function cacheStatusText(
  prev: { turn: number; cacheReadTokens: number | undefined },
  now: { turn: number; cacheReadTokens: number | undefined; expectedMiss?: boolean },
): { text: string; invariant: { kind: "cache-read-drop"; turn: number; previous: number; current: number } } | null {
  return cacheWarning(prev, now);
}

export function buildLoopContext(input: {
  base: ToolContext;
  events: readonly EventEnvelope[];
  epoch: number;
  contextFreeTokens: number;
}): ToolContext {
  return {
    ...input.base,
    readResults: buildReadResultsIndex(input.events, input.epoch),
    contextFreeTokens: input.contextFreeTokens,
  };
}

export async function projectRootOf(start: string): Promise<string> {
  return findProjectRoot(start);
}

export function loopRuleSet(input: {
  loaded: LoadedSettings;
  env: Env;
  parsers: ShellParsers;
  ruleContext: RuleContext;
  configDir: string;
}): { rules: RuleSet; warnings: { message: string }[] } {
  return ruleSetFromSettings(input);
}

export function shellToolFor(
  choice: ShellChoice | undefined,
  tmpDir: string,
  snapshot?: ShellSnapshot,
): ToolDefinition<unknown> {
  if (choice?.kind === "powershell")
    return createBashTool({ tmpDir, powershell: { edition: choice.edition ?? "pwsh" } }) as ToolDefinition<unknown>;
  if (choice?.kind === "git-bash")
    return createBashTool({ tmpDir, gitBash: true, snapshot }) as ToolDefinition<unknown>;
  return createBashTool({ tmpDir, snapshot }) as ToolDefinition<unknown>;
}

/** The shell tool's name as the system prompt's env facts state it (`transcript/system-prompt.ts`). */
export function shellToolName(choice: ShellChoice | undefined): string {
  if (choice?.kind === "powershell") return choice.edition === "windows" ? "Windows PowerShell 5.1" : "PowerShell 7";
  if (choice?.kind === "git-bash") return "Git Bash";
  return "Bash";
}

export function shellStatusLine(input: {
  choice: ShellChoice | undefined;
  parsers: boolean;
  languageMode?: string;
}): string {
  const shell = input.choice?.kind ?? "bash";
  const fallback = input.parsers ? "policy: full" : "policy: fallback (no parsers; shell analysis fail-closed)";
  const language = input.languageMode === undefined ? "" : `, language: ${input.languageMode}`;
  const note = input.choice?.note === undefined ? "" : ` (${input.choice.note})`;
  return `shell: ${shell}${note}, ${fallback}${language}`;
}

export const INTERRUPTED_NOT_RUN = "Not run: the user interrupted.";

export function interruptResults(calls: readonly ParsedCall[]): ExecutedResult[] {
  return calls.map((c) => ({
    callId: c.id,
    name: c.name,
    output: { status: "interrupted" as const, content: [{ kind: "text" as const, text: INTERRUPTED_TOOL_TEXT }] },
    invalid: false,
  }));
}

export function shutdownResults(): ExecutedResult[] {
  return [];
}

export function fileChangeEvents(
  results: readonly ExecutedResult[],
): NonNullable<NonNullable<ToolOutput["meta"]>["fileChanges"]> {
  return results.flatMap((r) => r.output.meta?.fileChanges ?? []);
}

/**
 * A history rejection unlocks the repair epoch: the turn driver appends it and headless exits 6
 * with the hint (event-log "Resume"). Every other failure offers nothing.
 */
export function historyRepairOffer(error: ProviderErrorInfo): { offer: string; hint: string } | null {
  if (!isHistoryRelated(error)) return null;
  return { offer: "Repair: continue in a new epoch built from the normalized transcript", hint: REPAIR_HINT };
}
