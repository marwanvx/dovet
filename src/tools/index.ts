// Public surface of the `tools` module (docs/specs/architecture.md "Modules"): Built-in tools, tool registry, output limiting and offloading, read-state tracking.
// Other modules import only from this file.

export { createBashTool } from "./bash.ts";
export { createEditTool, editTool } from "./edit.ts";
export { createGlobTool, globTool } from "./glob.ts";
export { createGrepTool, grepTool } from "./grep.ts";
export { limitOutput, type OffloadTarget, OUTPUT_LIMIT } from "./output.ts";
export { canReadWithoutPrompt, fileEffects, shellEffects } from "./policy.ts";
export { createReadTool, readTool } from "./read.ts";
export {
  buildReadResultsIndex,
  type ReadResultEntry,
  type ReadResultKey,
  type ReadResultsIndex,
} from "./read-results.ts";
export { createReadState, type ReadStateEntry, type ReadStateStore } from "./read-state.ts";
export { createToolRegistry, type PreparedCall, type ToolRegistry, toolCallData } from "./registry.ts";
export { strictSubsetViolations, toolInputSchema } from "./schema.ts";
export {
  commandEnv,
  parseEnvFile,
  type ShellSnapshot,
  type SnapshotResult,
  scopedSettingsEnv,
  startShellSnapshot,
} from "./shell-env.ts";
export type {
  ActionDescriptor,
  Effects,
  InputNormalization,
  SessionEffect,
  SessionInfo,
  ToolContext,
  ToolDefinition,
  ToolOutput,
  ToolPolicyState,
  ToolProgressEvent,
} from "./types.ts";
export { createWriteTool, writeTool } from "./write.ts";

import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import type { ToolDefinition } from "./types.ts";
import { writeTool } from "./write.ts";

/** Every built-in tool; each tool task appends here so the schema tests cover it. */
export const builtinTools: readonly ToolDefinition<unknown>[] = [
  readTool as ToolDefinition<unknown>,
  writeTool as ToolDefinition<unknown>,
  editTool as ToolDefinition<unknown>,
  grepTool as ToolDefinition<unknown>,
  globTool as ToolDefinition<unknown>,
];
