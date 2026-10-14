// What the Bash tool infers from a command's text: interactive programs, benign exit 1, recognized file views, repository-rewriting commands (tools §5.6, 5.9–5.11).
import { gitSubcommand, programOf, type Simple, simpleCommands } from "./shell-words.ts";

export const INTERACTIVE_NOTICE =
  'This command needs an interactive terminal, which isn\'t available. Use a non-interactive form (e.g. git commit -m "…").';

const EDITORS = new Set(["vim", "vi", "nvim", "nano", "emacs", "pico", "less", "more", "man", "top", "htop", "btop"]);
const SSH_WITH_VALUE = new Set("bcDEeFIiJLlmOopQRSWw".split("").map((c) => `-${c}`));
const BENIGN = new Set(["grep", "rg", "egrep", "fgrep", "find", "diff", "test", "["]);
const MESSAGE_FLAG = /^(--message|--file|--reuse-message|--no-edit|-[a-zA-Z]*[mFC])/;

function needsTerminal(s: Simple): boolean {
  const p = programOf(s);
  if (p === undefined) return false;
  if (EDITORS.has(p.program)) {
    if (s.piped && (p.program === "less" || p.program === "more")) return false;
    if ((p.program === "top" || p.program === "htop") && p.args.some((a) => a === "-b" || a === "-n")) return false;
    return true;
  }
  if (p.program === "ssh") {
    const positional: string[] = [];
    for (let i = 0; i < p.args.length; i++) {
      const a = p.args[i] ?? "";
      if (SSH_WITH_VALUE.has(a)) i++;
      else if (!a.startsWith("-")) positional.push(a);
    }
    return positional.length === 1 && !p.args.includes("-N") && !p.args.includes("-T");
  }
  if (p.program === "git") {
    const g = gitSubcommand(p.args);
    if (g === undefined) return false;
    if (g.sub === "commit") return !g.rest.some((a) => MESSAGE_FLAG.test(a));
    if (g.sub === "rebase") return g.rest.some((a) => a === "-i" || a === "--interactive");
    if (g.sub === "add") return g.rest.some((a) => ["-p", "-i", "--patch", "--interactive"].includes(a));
  }
  return false;
}

export function interactiveNotice(command: string): string | undefined {
  return simpleCommands(command)?.some(needsTerminal) ? INTERACTIVE_NOTICE : undefined;
}

/** Exit status 1 is not a failure for these: it means "no match" or "differs" (the last command decides the status). */
export function exitOneIsBenign(command: string): boolean {
  const last = simpleCommands(command)?.at(-1);
  const p = last && programOf(last);
  if (p === undefined) return false;
  if (BENIGN.has(p.program)) return true;
  if (p.program !== "git") return false;
  const sub = gitSubcommand(p.args)?.sub;
  return sub === "diff" || sub === "grep";
}

/** `git merge`, `pull`, `checkout` and `switch` change many files at once, so only their names are listed. */
export function rewritesWorktree(command: string): boolean {
  return (simpleCommands(command) ?? []).some((s) => {
    const p = programOf(s);
    if (p?.program !== "git") return false;
    const sub = gitSubcommand(p.args)?.sub;
    return sub === "merge" || sub === "pull" || sub === "checkout" || sub === "switch";
  });
}

const NO_ARG_FLAGS: Record<string, RegExp> = {
  cat: /^-[nAbEsTvet]+$/,
  nl: /(?!)/,
  head: /^-\d+$/,
  tail: /^-\d+$/,
  grep: /^-[a-zA-Z]*$/,
  egrep: /^-[a-zA-Z]*$/,
  fgrep: /^-[a-zA-Z]*$/,
  rg: /^-[a-zA-Z]*$/,
};
const WITH_VALUE_FLAGS: Record<string, string[]> = { head: ["-n", "-c"], tail: ["-n", "-c"] };
// Flags that take a value (-A 3, -e pat) or recurse into directories.
const GREP_UNSUITABLE = /[ABCefmdDrR]/;

/** A command that is one of cat/nl/head/tail/sed -n/grep/egrep/fgrep/rg on one file, no pipes or redirects (tools §5.9). */
export function fileView(command: string): { file: string; whole: boolean } | undefined {
  const all = simpleCommands(command);
  const only = all?.length === 1 ? all[0] : undefined;
  if (only === undefined || only.piped || only.redirected || only.dynamic) return undefined;
  const p = programOf(only);
  if (p === undefined) return undefined;
  const { program, args } = p;
  const positional: string[] = [];
  const flags: string[] = [];
  const valueFlags = WITH_VALUE_FLAGS[program] ?? [];
  if (program === "sed") {
    if (args.length !== 3 || args[0] !== "-n" || !/^\d+(,\d+)?p$/.test(args[1] ?? "")) return undefined;
    return { file: args[2] ?? "", whole: false };
  }
  const known = NO_ARG_FLAGS[program];
  if (known === undefined) return undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (valueFlags.includes(a)) {
      if (!/^\+?\d+$/.test(args[++i] ?? "")) return undefined;
      flags.push(a);
    } else if (a.startsWith("-") && a !== "-") {
      if (!known.test(a)) return undefined;
      if ((program.endsWith("grep") || program === "rg") && GREP_UNSUITABLE.test(a)) return undefined;
      flags.push(a);
    } else positional.push(a);
  }
  const grepLike = program.endsWith("grep") || program === "rg";
  if (grepLike ? positional.length !== 2 : positional.length !== 1) return undefined;
  const file = positional.at(-1) ?? "";
  if (file === "-") return undefined;
  return { file, whole: program === "cat" && flags.length === 0 };
}
