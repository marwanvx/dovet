// Public surface of the `agent` module (docs/specs/architecture.md "Modules"): Session, Runtime and event types.
// The TUI imports only this entry, through `index.ts`.
export { createRuntime, type Runtime, type RuntimeDeps } from "./runtime.ts";
