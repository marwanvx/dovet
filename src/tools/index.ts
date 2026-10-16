// Public surface of the `tools` module (docs/specs/architecture.md "Modules"): Built-in tools, tool registry, output limiting and offloading, read-state tracking.
// Other modules import only from this file.

export { createBashTool } from "./bash.ts";
export { collectOutput } from "./child-output.ts";
export { createEditTool, editTool } from "./edit.ts";
export { createGlobTool, globTool } from "./glob.ts";
export { createGrepTool, grepTool } from "./grep.ts";
export { stripHidden } from "./hidden.ts";
export { limitOutput, type OffloadTarget, OUTPUT_LIMIT } from "./output.ts";
export {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  enterPlanModeTool,
  exitPlanModeTool,
  planEdited,
  planFileFor,
  planSlug,
} from "./plan-mode.ts";
export { canReadWithoutPrompt, fileEffects, shellEffects } from "./policy.ts";
export { askQuestionTool, createAskQuestionTool } from "./questions.ts";
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
export { createTodoWriteTool, todoWriteTool } from "./todos.ts";
export type {
  ActionDescriptor,
  AskUserQuestionInput,
  Effects,
  InputNormalization,
  PlanAnswer,
  QuestionAnswers,
  SessionEffect,
  SessionInfo,
  ToolContext,
  ToolDefinition,
  ToolInteract,
  ToolOutput,
  ToolPolicyState,
  ToolProgressEvent,
} from "./types.ts";
export { NoUserAvailable } from "./types.ts";
export { createWriteTool, writeTool } from "./write.ts";

import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode.ts";
import { askQuestionTool } from "./questions.ts";
import { readTool } from "./read.ts";
import { todoWriteTool } from "./todos.ts";
import type { ToolDefinition } from "./types.ts";
import { writeTool } from "./write.ts";

/** Every built-in tool; each tool task appends here so the schema tests cover it. */
export const builtinTools: readonly ToolDefinition<unknown>[] = [
  readTool as ToolDefinition<unknown>,
  writeTool as ToolDefinition<unknown>,
  editTool as ToolDefinition<unknown>,
  grepTool as ToolDefinition<unknown>,
  globTool as ToolDefinition<unknown>,
  askQuestionTool as ToolDefinition<unknown>,
  todoWriteTool as ToolDefinition<unknown>,
  enterPlanModeTool as ToolDefinition<unknown>,
  exitPlanModeTool as ToolDefinition<unknown>,
];
