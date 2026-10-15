// Public surface of the `agent` module (docs/specs/architecture.md "Modules"): Session, Runtime and event types.
// The TUI imports only this entry, through `index.ts`.
export { createRuntime, type Runtime, type RuntimeDeps, type SessionOptions } from "./runtime.ts";
export {
  type AgentEvent,
  type CommandResult,
  type PermissionAnswer,
  type Session,
  SessionImpl,
  type SlashCommand,
  sessionToolNames,
  type UserInput,
} from "./session.ts";
