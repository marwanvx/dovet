// Command text in, what it runs out (permissions §4.0): every simple command, file operands, and whether it was fully understood.

import { type State, walkBash } from "./bash.ts";
import { type Analysis, type AnalyzeOptions, type Context, createContext, MAX_COMMAND_CHARS } from "./context.ts";
import type { ShellLanguage, ShellParsers } from "./load.ts";
import { walkPowerShell } from "./powershell.ts";

export type { Analysis, AnalyzeOptions, Operand } from "./context.ts";

const DEFAULT_BUDGET_MS = 200;
const BENIGN_EXIT_ONE = new Set([
  "select-string",
  "findstr",
  "fc",
  "fc.exe",
  "where.exe",
  "diff.exe",
  "egrep",
  "fgrep",
]);

/** A parse error, a timeout or a crash gives `commands: undefined` and `understood: false`: never an allow (§4.0 item 7). */
export function analyzeShell(
  parsers: ShellParsers,
  language: ShellLanguage,
  command: string,
  opts: AnalyzeOptions,
): Analysis {
  const ctx = createContext(opts);
  const deadline = performance.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const state: State = { cwd: opts.cwd, stack: [], loops: new Map(), depth: 0 };
  const run = (text: string, st: State): boolean => {
    const left = deadline - performance.now();
    if (left <= 0) return false;
    return (
      parsers.withTree("bash", text, left, (root) => {
        if (root.hasError) ctx.fail("parse error");
        walkBash(root, walkHooks(ctx, run), st);
        return true;
      }) ?? false
    );
  };
  const unparsed = (reason: string): Analysis => ({
    commands: undefined,
    understood: false,
    literalNames: false,
    reasons: [reason],
    operands: [],
  });
  if (command.length > MAX_COMMAND_CHARS) ctx.fail(`longer than ${MAX_COMMAND_CHARS} characters`);
  let parsed: boolean | undefined;
  try {
    if (language === "bash") parsed = run(command, state);
    else
      parsed = parsers.withTree("powershell", command, opts.budgetMs ?? DEFAULT_BUDGET_MS, (root) => {
        if (root.hasError) ctx.fail("parse error");
        walkPowerShell(root, ctx, { cwd: opts.cwd, stack: [] });
        return true;
      });
  } catch (e) {
    return unparsed(`analysis failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed) return unparsed(`parsing took longer than ${opts.budgetMs ?? DEFAULT_BUDGET_MS} ms or failed`);
  return {
    commands: ctx.commands,
    understood: ctx.reasons.length === 0,
    literalNames: ctx.state.literalNames,
    reasons: ctx.reasons,
    operands: ctx.operands,
  };
}

const walkHooks = (ctx: Context, script: (text: string, st: State) => boolean) => ({ ctx, script });

/** Exit status 1 means "no match" or "differs" for these (tools §6.6, with the Bash list); the last command decides. */
export function powershellExitOneIsBenign(commands: Analysis["commands"]): boolean {
  const last = commands?.at(-1)?.argv;
  const name = last?.[0]?.toLowerCase();
  if (name === undefined) return false;
  return BENIGN_EXIT_ONE.has(name) || (name === "git" && (last?.[1] === "diff" || last?.[1] === "grep"));
}
