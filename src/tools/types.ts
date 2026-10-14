// Tool contracts (interfaces §4). Services a tool needs (snapshots, sandbox, interact, model) are added by the first tool that uses them.
import type { z } from "zod";
import type { Platform } from "../platform/index.ts";
import type { AbsPath, DocumentPart, ImagePart, PermissionMode, Settings, TextPart } from "../schema/index.ts";
import type { ReadResultsIndex } from "./read-results.ts";
import type { ReadStateStore } from "./read-state.ts";

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
    fileChanges?: Array<{ path: AbsPath; op: "create" | "modify"; added: number; removed: number }>;
  };
};

export type Effects = {
  writes: "workspace" | "outside" | "protected" | "none" | "unknown";
  network: "none" | "allowed-hosts" | { newHosts: string[] } | "unknown";
  sensitiveReads: AbsPath[];
  remote: Array<"push" | "publish" | "upload" | "deploy" | "destructive-mcp">;
  sandboxed: boolean;
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
  platform: Platform;
}

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
