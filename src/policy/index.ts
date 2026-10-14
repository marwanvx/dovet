// Public surface of the `policy` module (docs/specs/architecture.md "Modules"): Permission rules, shell parsing, path policy, sandbox, taint state, secret redaction.
// Other modules import only from this file.

export type { SandboxOs, SandboxStartOptions, SrtHelperFile } from "./sandbox/init.ts";
export { SRT_HELPER_FILES, sandboxRuntimeConfig, srtHelpersFor, startSandbox } from "./sandbox/init.ts";
export type { ParsedCommand, ShellLanguage, ShellParsers } from "./shell-parse/load.ts";
export { loadShellParsers } from "./shell-parse/load.ts";
export type {
  Behavior,
  Example,
  Rule,
  RuleCall,
  RuleContext,
  RuleIssue,
  RuleMatch,
  RuleSet,
  RuleSource,
  RuleText,
  Subcommand,
} from "./rules/index.ts";
export { checkExamples, evaluateRules, loadRules, ruleTexts, splitCommand } from "./rules/index.ts";
