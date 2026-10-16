// Session and Runtime wiring (interfaces §6, §9): isolated per-session state, plan file and answering.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Platform } from "../platform/index.ts";
import type { AbsPath, BlobRef, PermissionMode, Ulid } from "../schema/index.ts";
import {
  collectOutput,
  createReadState,
  planFileFor,
  planSlug,
  type SessionEffect,
  type ToolContext,
} from "../tools/index.ts";
import { InputQueue } from "./interrupts.ts";

async function readPlanFile(path: AbsPath): Promise<string> {
  return readFile(path, "utf8");
}

export type SessionOptions = {
  cwd: AbsPath;
  resume?: Ulid;
  fork?: { from: Ulid; atEvent: Ulid };
  interactive: boolean;
  overrides: Record<string, unknown>;
  parent?: { sessionId: Ulid; budgetSlice: number | null; tools: string[] };
};

export type SessionDeps = {
  clock: { now(): number };
  ids: { ulid(): Ulid };
  platform: Platform;
  dirs: { config: AbsPath; data: AbsPath; cache: AbsPath };
  env: Readonly<Record<string, string>>;
  baseUrls?: Partial<Record<string, string>>;
  stdio: { isTTY: boolean };
};

const Attachment = z.strictObject({
  kind: z.enum(["image", "file"]),
  path: z.string().optional(),
  blob: z.custom<BlobRef>().optional(),
});
const UserInputSchema = z.strictObject({ text: z.string(), attachments: z.array(Attachment) });
const PermissionAnswerSchema = z.strictObject({
  decision: z.enum(["yes", "yes-remember", "no"]),
  comment: z.string().optional(),
  editedRule: z.string().optional(),
});
const QuestionAnswersSchema = z.union([
  z.strictObject({
    answers: z.array(
      z.strictObject({
        selected: z.array(z.string()),
        other: z.string().optional(),
        notes: z.array(z.strictObject({ label: z.string(), text: z.string() })),
      }),
    ),
  }),
  z.strictObject({ dismissed: z.literal(true) }),
]);
const PlanAnswerSchema = z.union([
  z.strictObject({ approve: z.enum(["previous", "accept-edits", "manual"]), edited: z.boolean() }),
  z.strictObject({ keepPlanning: z.string() }),
  z.strictObject({ dismissed: z.literal(true), reason: z.enum(["esc", "mode-changed"]) }),
]);

export type UserInput = z.infer<typeof UserInputSchema>;
export type PermissionAnswer = z.infer<typeof PermissionAnswerSchema>;
export type SlashCommand = { name: string; args: string };
export type CommandResult = { ok: true; output?: string } | { ok: false; error: string };
export type AgentEvent =
  | {
      type: "status";
      state: "idle" | "thinking" | "waiting-model" | "retrying" | "running-tools" | "awaiting-user";
      detail?: string;
    }
  | { type: "stream.text"; turn: number; blockIndex: number; text: string }
  | { type: "stream.reasoning"; turn: number; text: string }
  | { type: "stream.toolInput"; callId: string; partialJson: string }
  | { type: "tool.progress"; callId: string; tail: string[]; elapsedMs: number }
  | { type: "meter"; turnUsd: number; sessionUsd: number; contextPct: number; cacheHitPct: number }
  | { type: "queue"; pending: number }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "user.shell"; command: string; exitCode: number | null; output: string };

export interface Session {
  readonly id: Ulid;
  events(): AsyncIterable<AgentEvent>;
  submit(input: UserInput): void;
  sendQueuedNow(): void;
  interrupt(): void;
  answerPermission(requestId: Ulid, answer: PermissionAnswer): void;
  answerQuestion(requestId: Ulid, answers: unknown): void;
  answerPlan(requestId: Ulid, answer: unknown): void;
  runUserShell(command: string): Promise<{ exitCode: number | null; output: string }>;
  command(cmd: SlashCommand): Promise<CommandResult>;
  close(): Promise<void>;
}

type Pending = { resolve: (v: never) => void };

export function sessionToolNames(opts: { headless: boolean }): string[] {
  const base = ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "TodoWrite", "EnterPlanMode", "ExitPlanMode"];
  return opts.headless ? base : [...base, "AskUserQuestion"];
}

export class SessionImpl implements Session {
  readonly id: Ulid;
  readonly cwd: string;
  readonly sessionDir: string;
  private queue = new InputQueue();
  private live: AgentEvent[] = [];
  private waiters: Array<(e: AgentEvent) => void> = [];
  private pending = new Map<string, Pending>();
  private closedFlag = false;
  private mode: PermissionMode = "default";
  private previousMode: PermissionMode | undefined;
  private currentPlan: AbsPath | undefined;
  private tainted: string[] = [];
  private shellOutput = "";
  private aborter = new AbortController();

  constructor(
    private readonly deps: SessionDeps,
    private readonly opts: SessionOptions,
  ) {
    this.id = deps.ids.ulid();
    this.cwd = opts.cwd as string;
    this.sessionDir = `${deps.dirs.data}/sessions/${this.id}`;
  }

  get planPath(): AbsPath | undefined {
    return this.currentPlan;
  }

  declaredTools(): string[] {
    return sessionToolNames({ headless: !this.opts.interactive });
  }

  applyEffects(effects: readonly SessionEffect[]): void {
    for (const e of effects) {
      if (e.kind === "set-mode") {
        if (e.mode === "plan" && this.mode !== "plan") this.previousMode = this.mode;
        this.mode = e.mode;
      } else if (e.kind === "taint") {
        if (!this.tainted.includes(e.source)) this.tainted.push(e.source);
      } else if (e.kind === "cwd") {
        (this as { cwd: string }).cwd = e.path as string;
      }
    }
  }

  private emit(e: AgentEvent): void {
    this.live.push(e);
    for (const w of this.waiters.splice(0)) w(e);
  }

  async *events(): AsyncIterable<AgentEvent> {
    yield { type: "status", state: "idle" };
    let seen = this.live.length;
    for (;;) {
      if (this.closedFlag) return;
      const next = await new Promise<AgentEvent>((resolve) => {
        this.waiters.push(resolve);
      });
      seen += 1;
      void seen;
      yield next;
    }
  }

  submit(raw: UserInput): void {
    if (this.closedFlag) return;
    const input = UserInputSchema.parse(raw);
    const text = this.shellOutput !== "" ? `${this.shellOutput}\n${input.text}` : input.text;
    this.shellOutput = "";
    this.queue.queue({ text, attachments: [] });
    this.emit({ type: "queue", pending: this.queue.size });
  }

  sendQueuedNow(): void {
    if (this.queue.size > 0) this.emit({ type: "queue", pending: this.queue.size });
  }

  interrupt(): void {
    this.queue.takeAll();
    this.aborter.abort();
    this.aborter = new AbortController();
    this.emit({ type: "queue", pending: 0 });
    this.emit({ type: "status", state: "idle" });
  }

  answerPermission(requestId: Ulid, raw: PermissionAnswer): void {
    const answer = PermissionAnswerSchema.parse(raw);
    this.pending.get(requestId)?.resolve(answer as never);
    this.pending.delete(requestId);
  }

  answerQuestion(requestId: Ulid, raw: unknown): void {
    const answers = QuestionAnswersSchema.parse(raw);
    this.pending.get(requestId)?.resolve(answers as never);
    this.pending.delete(requestId);
  }

  answerPlan(requestId: Ulid, raw: unknown): void {
    const answer = PlanAnswerSchema.parse(raw);
    this.pending.get(requestId)?.resolve(answer as never);
    this.pending.delete(requestId);
  }

  toolContext(): ToolContext {
    return {
      session: {
        id: this.id,
        cwd: this.cwd as AbsPath,
        workingDirs: [this.cwd as AbsPath],
        mode: this.mode,
        taint: [...this.tainted],
        interactive: this.opts.interactive,
      },
      settings: this.opts.overrides as never,
      signal: this.aborter.signal,
      readState: createReadState(this.deps.platform.os as never),
      readResults: { lookup: () => undefined },
      contextFreeTokens: 200_000,
      recordWrite: () => Promise.resolve(),
      emit: () => undefined,
      platform: this.deps.platform as never,
      env: this.deps.env as never,
      planPreviousMode: this.previousMode,
      interact: {
        askQuestions: (q, signal) => this.waitForAnswer(q, signal),
        presentPlan: (p, signal) => this.waitForAnswer(p, signal),
      },
    } as ToolContext;
  }

  private waitForAnswer(_body: unknown, signal: AbortSignal): Promise<never> {
    const id = this.deps.ids.ulid();
    this.emit({ type: "status", state: "awaiting-user", detail: id });
    return new Promise<never>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void });
      signal.addEventListener("abort", () => {
        this.pending.delete(id);
        reject(new Error("aborted"));
      });
    });
  }

  private planDirectory(): string | undefined {
    const plan = (this.opts.overrides as { plan?: { directory?: string } }).plan;
    return plan?.directory;
  }

  enterPlanMode(promptText: string): void {
    if (this.mode !== "plan") this.previousMode = this.mode;
    this.mode = "plan";
    const suffix = this.id.slice(-4).toLowerCase();
    this.currentPlan = planFileFor(this.sessionDir, this.cwd, this.planDirectory(), planSlug(promptText, suffix));
  }

  async runUserShell(command: string): Promise<{ exitCode: number | null; output: string }> {
    const shells = this.deps.platform.shells();
    const shell = shells.bash ?? shells.gitBash ?? "/bin/sh";
    const child = this.deps.platform.spawn({
      argv: [shell, "-c", command],
      cwd: this.cwd,
      env: { ...(this.deps.env as Record<string, string>) },
      group: this.id,
      signal: this.aborter.signal,
    });
    const { merged, code } = await collectOutput(child, { maxBytes: 64 * 1024 * 1024 });
    const output = merged.toString("utf8").slice(0, 30_000);
    this.emit({ type: "user.shell", command, exitCode: code, output });
    this.shellOutput = output;
    return { exitCode: code, output };
  }

  async command(cmd: SlashCommand): Promise<CommandResult> {
    if (cmd.name === "plan") {
      if (this.mode === "plan") {
        if (cmd.args.trim() === "open")
          return this.currentPlan === undefined
            ? { ok: true, output: "No plan written yet." }
            : { ok: true, output: this.currentPlan };
        if (this.currentPlan !== undefined) {
          try {
            return { ok: true, output: await readPlanFile(this.currentPlan) };
          } catch {
            return { ok: true, output: "No plan written yet." };
          }
        }
        return { ok: true, output: "No plan written yet." };
      }
      this.enterPlanMode(cmd.args);
      if (cmd.args.trim() !== "") this.queue.queue({ text: cmd.args, attachments: [] });
      return { ok: true };
    }
    if (cmd.name === "clear") {
      this.currentPlan = undefined;
      return { ok: true };
    }
    if (cmd.name === "untaint") {
      if (this.tainted.length === 0) return { ok: true, output: "Session is not tainted." };
      if (cmd.args.trim() !== "confirm") {
        return {
          ok: false,
          error: `Session is tainted by ${this.tainted.join(", ")}. Run /untaint confirm to clear it. This is logged.`,
        };
      }
      const cleared = [...this.tainted];
      this.tainted = [];
      this.emit({ type: "notice", level: "info", text: `Session untainted (was: ${cleared.join(", ")}).` });
      return { ok: true, output: `Session untainted (was: ${cleared.join(", ")}).` };
    }
    return { ok: false, error: `Unknown command /${cmd.name}` };
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    for (const w of this.waiters.splice(0)) w({ type: "status", state: "idle" });
  }
}
