// Public surface of the `tools` module (docs/specs/architecture.md "Modules"): Built-in tools, tool registry, output limiting and offloading, read-state tracking.
// Other modules import only from this file.
export { limitOutput, type OffloadTarget, OUTPUT_LIMIT } from "./output.ts";
export { createReadState, type ReadStateEntry, type ReadStateStore } from "./read-state.ts";
export { createToolRegistry, type PreparedCall, type ToolRegistry, toolCallData } from "./registry.ts";
export { strictSubsetViolations, toolInputSchema } from "./schema.ts";
export type {
  ActionDescriptor,
  Effects,
  InputNormalization,
  SessionEffect,
  SessionInfo,
  ToolContext,
  ToolDefinition,
  ToolOutput,
  ToolProgressEvent,
} from "./types.ts";
