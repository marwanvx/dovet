import type { Settings } from "../../schema/index.ts";
import { type LoadedSettings, type Problem, SettingsError, type SettingsSource } from "../../store/index.ts";
import { type Env, exampleDecider } from "../decide/index.ts";
import {
  type Behavior,
  checkExamples,
  loadRules,
  type RuleContext,
  type RuleIssue,
  type RuleSet,
  type RuleSource,
} from "../rules/index.ts";
import type { ShellParsers } from "../shell-parse/load.ts";

export type RuleSetInput = {
  loaded: LoadedSettings;
  env: Env;
  parsers: ShellParsers;
  ruleContext: RuleContext;
  configDir: string;
};

export const PRODUCTION_TOOL_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Bash", new Set(["dangerouslyDisableSandbox"])],
  ["PowerShell", new Set(["dangerouslyDisableSandbox"])],
]);

const problem = (i: RuleIssue): Problem => ({ file: i.file, line: i.line, key: "", message: i.message });

/** Compiles every loaded rule and checks `permissions.examples`; a malformed rule or a failing example is a settings error (permissions §3.1). */
export function ruleSetFromSettings(input: RuleSetInput): { rules: RuleSet; warnings: RuleIssue[] } {
  const { loaded, env } = input;
  const baseOf = (source: SettingsSource): string =>
    source === "user"
      ? input.configDir
      : source === "claude-user"
        ? `${env.home}/.claude`
        : (env.workingDirs[0] ?? env.cwd);
  const sources = new Map<string, RuleSource>();
  for (const behavior of ["allow", "ask", "deny"] as const satisfies Behavior[]) {
    for (const { rule, source, file } of loaded.rules[behavior]) {
      const key = file ?? `(${source})`;
      const entry = sources.get(key) ?? { file: key, baseDir: baseOf(source) };
      entry[behavior] = [...(entry[behavior] ?? []), { text: rule }];
      sources.set(key, entry);
    }
  }
  const toolParams = new Map<string, ReadonlySet<string>>(PRODUCTION_TOOL_PARAMS);
  if (input.ruleContext.toolParams !== undefined) {
    for (const [tool, params] of input.ruleContext.toolParams) {
      toolParams.set(tool, new Set([...(toolParams.get(tool) ?? []), ...params]));
    }
  }
  const ruleContext: RuleContext = { ...input.ruleContext, toolParams };
  const { rules, issues } = loadRules([...sources.values()], ruleContext);
  const examples: NonNullable<Settings["permissions"]>["examples"] = loaded.settings.permissions?.examples ?? [];
  issues.push(
    ...checkExamples(rules, examples, {
      cwd: env.cwd,
      decide: exampleDecider({ mode: "default", rules, env }, input.parsers),
    }),
  );
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) throw new SettingsError(errors.map(problem));
  return { rules, warnings: issues.filter((i) => i.severity === "warning") };
}
