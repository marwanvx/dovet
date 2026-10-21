// Tool contracts (interfaces §4). Services a tool needs (snapshots, sandbox, interact, model) are added by the first tool that uses them.
import type { z } from "zod";
import type { Platform } from "../platform/index.ts";
import type { Effects, Env, RuleSet, SandboxService, ShellParsers } from "../policy/index.ts";
import type { AbsPath, DocumentPart, ImagePart, PermissionMode, Settings, TextPart } from "../schema/index.ts";
import type { Snapshotter } from "../store/index.ts";
import type { ReadResultsIndex } from "./read-results.ts";
import type { ReadStateStore } from "./read-state.ts";

export type { Effects } from "../policy/index.ts";

/** The one wording for a tool still running when the user interrupted (agent-loop TOOLS interrupt row). */
export const INTERRUPTED_TOOL_TEXT = "Interrupted by the user before this tool finished.";

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
    /** WebSearch: which backend answered and what the search cost (receipts-budgets "Web search"). */
    search?: { backend: string; calls: number; priceUsd?: number };
    fileChanges?: Array<{
      path: AbsPath;
      op: "create" | "modify" | "delete";
      added: number;
      removed: number;
      /** SHA-256 of the bytes the change left (null = deleted): what a rewind treats as Dovet's last write. */
      after?: string | null;
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

export type SearchHit = { title: string; url: string; snippet?: string; date?: string };

/** The secondary request WebSearch's `provider` backend makes (ADR-25, interfaces §4). */
export type SecondaryRequest = {
  purpose: "websearch";
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
};

export type SecondaryResult = {
  results: SearchHit[];
  usage: Record<string, unknown>;
  serverToolCalls: number;
  requestId?: string;
  /** Set when the stream dropped: `results` holds what arrived before it (tools §10). */
  dropped?: string;
};

/** The API refused the search mechanism for this model (tools §10: marked unsupported for the session). */
export class SearchMechanismRejected extends Error {}

export interface ToolInteract {
  askQuestions(q: AskUserQuestionInput, signal: AbortSignal): Promise<QuestionAnswers>;
  presentPlan(plan: { text: string; path: AbsPath }, signal: AbortSignal): Promise<PlanAnswer>;
}

/** What the session model can take as images, and the budget of the epoch (tools §1.6). */
export type MediaContext = {
  images: boolean;
  /** The model's native long edge in px; Read sends at most min(2,000, this). */
  longEdge: number;
  /** The model takes `document` parts (PDFs); otherwise Read extracts the text of the pages. */
  pdfs: boolean;
  /** Most pages one document may have; null = no check. */
  pdfMaxPages: number | null;
  claim(bytes: number, kind: "image" | "document"): string | undefined;
  /** Stores the bytes where the log refers to them; returns the SHA-256. */
  store(bytes: Uint8Array): string;
};

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
  /** Why a shell command's changes can't be undone, when `snapshots` is absent; given once per turn (checkpoints "Limits"). */
  shellNotice?: () => string | undefined;
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
  /** The session model's secondary requests (WebSearch's provider backend); absent when its endpoint has no search mechanism. `id` is `provider/model`. */
  model?: { id: string; complete(req: SecondaryRequest, signal: AbortSignal): Promise<SecondaryResult> };
  /** Absent when the session cannot take images (unit tests, models without image input). */
  media?: MediaContext;
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
  taintSource?: string;
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
