// Tool contracts (interfaces §4). Services a tool needs (snapshots, sandbox, interact, model) are added by the first tool that uses them.
import type { z } from "zod";
import type { Platform } from "../platform/index.ts";
import type { Effects, Env, RuleSet, SandboxService, ShellParsers } from "../policy/index.ts";
import type { AbsPath, DocumentPart, ImagePart, PermissionMode, Settings, TextPart } from "../schema/index.ts";
import type { Snapshotter } from "../store/index.ts";
import type { ReadResultsIndex } from "./read-results.ts";
import type { ReadStateStore } from "./read-state.ts";

export type { Effects } from "../policy/index.ts";

export type SessionEffect =
  | { kind: "set-mode"; mode: PermissionMode }
  | { kind: "taint"; source: string }
  | { kind: "cwd"; path: AbsPath };

export type ToolOutput = {
  status: "ok" | "error" | "denied" | "interrupted" | "timeout";
  content: Array<TextPart | ImagePart | DocumentPart>;
  meta?: {
    exitCode?: number;
    durationMs?: number;
    offloadPath?: AbsPath;
    sandboxViolations?: string[];
    effects?: SessionEffect[];
    fileChanges?: Array<{
      path: AbsPath;
      op: "create" | "modify";
      added: number;
      removed: number;
      match?: "exact" | "prefix-strip" | "indent";
    }>;
  };
};

export type ActionDescriptor = { effects: Effects } & (
  | { kind: "read"; paths: AbsPath[] }
  | { kind: "edit"; paths: AbsPath[]; preview?: { path: AbsPath; diff: string }[] }
  | { kind: "shell"; shell: "bash" | "powershell"; command: string; sandboxed: boolean; unsandboxedRetry: boolean }
  | { kind: "network"; url: string; host: string; via: "webfetch" | "websearch" }
  | { kind: "interaction" }
  | { kind: "task-list" }
);

export type SessionInfo = {
  id: string;
  cwd: AbsPath;
  workingDirs: readonly AbsPath[];
  mode: PermissionMode;
  taint: readonly string[];
  interactive: boolean;
};

export type ToolProgressEvent = { kind: "status"; text: string } | { kind: "tail"; text: string };

export type AskUserQuestionInput = {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string; preview?: string | undefined }>;
    multiSelect: boolean;
  }>;
};

export type QuestionAnswers =
  | { answers: Array<{ selected: string[]; other?: string; notes: Array<{ label: string; text: string }> }> }
  | { dismissed: true };

export type PlanAnswer =
  | { approve: "previous" | "accept-edits" | "manual"; edited: boolean }
  | { keepPlanning: string }
  | { dismissed: true; reason: "esc" | "mode-changed" };

export class NoUserAvailable extends Error {}

export interface ToolInteract {
  askQuestions(q: AskUserQuestionInput, signal: AbortSignal): Promise<QuestionAnswers>;
  presentPlan(plan: { text: string; path: AbsPath }, signal: AbortSignal): Promise<PlanAnswer>;
}

export interface ToolContext {
  session: Readonly<SessionInfo>;
  settings: Readonly<Settings>;
  signal: AbortSignal;
  readState: ReadStateStore;
  readResults: ReadResultsIndex;
  /** Tokens still free before the compaction threshold (allow_large, tools §1.4). */
  contextFreeTokens: number;
  /** Records a file's before-state for the checkpoint; a writing tool awaits it before it changes the file (null = new file). */
  recordWrite(path: AbsPath, before: Uint8Array | null): Promise<void>;
  emit(e: ToolProgressEvent): void;
  /** Lets Bash list the files a command changed (checkpoints); absent until the session wires it (M1-25). */
  snapshots?: Pick<Snapshotter, "root" | "snapshot" | "changes">;
  platform: Platform;
  /** The environment child processes inherit (ripgrep needs `HOME` to find the global git excludes). */
  env: Readonly<Record<string, string | undefined>>;
  /** Policy state for `describeAction` and the silent read; absent in unit tests without policy (M1-23c). */
  policy?: ToolPolicyState;
  /** Sandbox service (permissions §7): health-gated wrapping, violations, session temp dir. */
  sandbox?: SandboxService;
  /** The hard-linked keep-link approval (tools §2.7); set by the loop after the `hard-linked` prompt. */
  keepHardLink?: boolean;
  /** User interaction (tools §4, §11); absent in unit tests that never prompt. */
  interact?: ToolInteract;
  /** Mode active before plan mode; used when ExitPlanMode approves to `previous` (tools §11.4). */
  planPreviousMode?: PermissionMode;
}

/** What `describeAction` needs to run the decision and `effectsOf` (M1-23c; wired by M1-25). */
export type ToolPolicyState = {
  rules: RuleSet;
  mode: PermissionMode;
  env: Env;
  parsers?: ShellParsers;
  /** Whether a shell command would run inside the sandbox. */
  sandboxed?: boolean;
  tainted?: boolean;
  sandboxAutoAllow?: boolean;
  defaultBranch?: string;
  blockReadsOutsideWorkingDirectories?: boolean;
};

/** Deterministic input rewrites applied before validation (tools §0). */
export type InputNormalization = {
  /** alias → real field name */
  aliases?: Readonly<Record<string, string>>;
  /** fields some models add that the tool ignores */
  drop?: readonly string[];
  /** tool-specific rewrite that runs last (Grep's `-l`/`-c` flags) */
  rewrite?: (input: Record<string, unknown>) => Record<string, unknown>;
};

export interface ToolDefinition<I, O = ToolOutput> {
  name: string;
  input: z.ZodType<I>;
  descriptionFile: string;
  errorExample: I;
  parallelSafe: boolean;
  mutates: "none" | "files" | "system" | "network";
  normalize?: InputNormalization;
  /** String fields that are paths or patterns; a null byte in one is refused. */
  pathFields?: readonly string[];
  /** The tool applies its own size limit, so the generic 30,000-character output limit is skipped (Read). */
  limitsOwnOutput?: true;
  describeAction(input: I, ctx: ToolContext): ActionDescriptor;
  run(input: I, ctx: ToolContext): Promise<O>;
}
