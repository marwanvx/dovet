// Command text in, what it runs out (permissions §4.0): every simple command, file operands, and whether it was fully understood.

import { joinContinuations, type State, walkBash } from "./bash.ts";
import { type Analysis, type AnalyzeOptions, createContext, MAX_COMMAND_CHARS } from "./context.ts";
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
  ctx.deadline.at = deadline;
  const state: State = { cwd: opts.cwd, stack: [], loops: new Map(), depth: 0 };
  // A nested script's error counts too: the grammar can lose a whole command to one (`coproc X if(true)then …`).
  let topError = false;
  // The tree of the joined text must locate its quotes and comments where the first reading did, or it misread one.
  const run = (text: string, st: State, joined = false): boolean => {
    const left = deadline - performance.now();
    if (left <= 0) return false;
    return (
      parsers.withTree("bash", text, left, (root) => {
        const bashText = joinContinuations(root, text);
        if (bashText !== text && !joined) return run(bashText, st, true);
        if (bashText !== text) ctx.state.misread = true;
        if (root.hasError) {
          ctx.fail("parse error");
          topError = true;
        }
        walkBash(root, { ctx, script: (t, s) => run(t, s) }, st);
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
        if (root.hasError) {
          ctx.fail("parse error");
          topError = true;
        }
        walkPowerShell(root, ctx, { cwd: opts.cwd, stack: [] }, (text, cwd) =>
          run(text, { cwd, stack: [], loops: new Map(), depth: 1 }),
        );
        return true;
      });
  } catch (e) {
    return unparsed(`analysis failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed && performance.now() > deadline) parsed = false;
  if (topError || ctx.state.misread)
    return {
      commands: undefined,
      understood: false,
      literalNames: false,
      reasons: [
        topError
          ? "the parser reported a syntax error"
          : "the parser misread a compound command or a line continuation",
      ],
      operands: [],
      // The lines before the erroring one run (the tool executes a script file): the checks see them, the ask stands.
      recovered: { commands: ctx.commands, operands: ctx.operands },
    };
  if (!parsed) return unparsed(`parsing took longer than ${opts.budgetMs ?? DEFAULT_BUDGET_MS} ms or failed`);
  return {
    commands: ctx.commands,
    understood: ctx.reasons.length === 0,
    literalNames: ctx.state.literalNames,
    reasons: ctx.reasons,
    operands: ctx.operands,
  };
}

/** Exit status 1 means "no match" or "differs" for these (tools §6.6, with the Bash list); the last command decides. */
export function powershellExitOneIsBenign(commands: Analysis["commands"]): boolean {
  const last = commands?.at(-1)?.argv;
  const name = last?.[0]?.toLowerCase();
  if (name === undefined) return false;
  return BENIGN_EXIT_ONE.has(name) || (name === "git" && (last?.[1] === "diff" || last?.[1] === "grep"));
}
