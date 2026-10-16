// Public surface of the `policy` module (docs/specs/architecture.md "Modules"): Permission rules, shell parsing, path policy, sandbox, taint state, secret redaction.
// Other modules import only from this file.

export type { Action, Decision, Env, Finding, FindingKind, Request, State } from "./decide/index.ts";
export { decide, exampleDecider, planExitChoices } from "./decide/index.ts";
export type { Effects, Grant, RuleSetInput } from "./grants/index.ts";
export { effectsOf, ruleSetFromSettings, saveGrant, suggestGrant } from "./grants/index.ts";
export type {
  Behavior,
  Example,
  ExampleDecide,
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
export {
  expandProtectedSymlinks,
  isExcludedCommand,
  normalizeHost,
  normalizeSandboxPath,
  sandboxProtectedDenyWrite,
  worktreeCommonDenies,
} from "./sandbox/hygiene.ts";
export type { SandboxOs, SandboxStartOptions, SrtHelperFile } from "./sandbox/init.ts";
export { SRT_HELPER_FILES, sandboxRuntimeConfig, srtHelpersFor, startSandbox } from "./sandbox/init.ts";
export type { MxcSupport } from "./sandbox/mxc.ts";
export { checkMxcSupport, mxcConfigFor } from "./sandbox/mxc.ts";
export {
  extractHosts,
  type HostAskMode,
  hostNeedsTaint,
  isLoopbackName,
  isRegistryHost,
  makeHostAsker,
  shouldRefuseLocalHost,
  taintSourceForCommand,
} from "./sandbox/network.ts";
export type { SandboxBackend, SandboxService, SandboxState, SandboxWrapped } from "./sandbox/service.ts";
export {
  backendFor,
  createSandboxService,
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_CREDENTIAL_DENY_FILES,
  fakeSandboxService,
  sandboxConfigFor,
  sandboxStatus,
} from "./sandbox/service.ts";
export { selectWindowsBackend, windowsStatusText } from "./sandbox/windows.ts";
export type { Analysis, AnalyzeOptions, Operand } from "./shell-parse/analyze.ts";
export { analyzeShell, powershellExitOneIsBenign } from "./shell-parse/analyze.ts";
export { expandGlob, isDirectory } from "./shell-parse/glob.ts";
export type { ParsedCommand, ShellLanguage, ShellParsers } from "./shell-parse/load.ts";
export { loadShellParsers } from "./shell-parse/load.ts";
