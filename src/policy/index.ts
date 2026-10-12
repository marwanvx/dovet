// Public surface of the `policy` module (docs/specs/architecture.md "Modules"): Permission rules, shell parsing, path policy, sandbox, taint state, secret redaction.
// Other modules import only from this file.
export type { ParsedCommand, ShellLanguage, ShellParsers } from "./shell-parse/load.ts";
export { loadShellParsers } from "./shell-parse/load.ts";
