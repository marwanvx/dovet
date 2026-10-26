export type { Example, ExampleDecide, RuleCall, RuleMatch, RuleSet } from "./evaluate.ts";
export { checkExamples, evaluateRules, loadRules } from "./evaluate.ts";
export type { Behavior, Rule, RuleContext, RuleIssue, RuleSource, RuleText } from "./parse.ts";
export { ruleTexts } from "./parse.ts";
export { escapeLiteral, toPosix } from "./paths.ts";
export type { Redirect, Subcommand } from "./shell.ts";
export {
  allowRuleArgv,
  canonicalCmdlet,
  commandFromInput,
  commandName,
  findCommands,
  findCommandsAt,
  isExecWrapper,
  isLongOption,
  isSafeEnv,
  needsExactRule,
  PARALLEL_PROGRAMS,
  PARALLEL_REPLACEMENT,
  shellScriptAt,
  splitCommand,
  strippedArgvs,
  unwrapCommand,
  xargsCommandStarts,
} from "./shell.ts";
