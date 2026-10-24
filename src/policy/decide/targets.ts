// The files a shell command writes or reads that the analyzer does not already list as operands (permissions §4.0 item 4, §4.5).
import { commandName, findCommands, type Subcommand, xargsCommandStarts } from "../rules/index.ts";

export type Target = { access: "read" | "edit"; path: string; cwd: string };

export const FS_COMMANDS = new Set([
  "mkdir",
  "touch",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "sed",
  "set-content",
  "add-content",
  "clear-content",
  "remove-item",
]);
const EVERY_ARG = new Set([
  "tee",
  "mkdir",
  "touch",
  "rm",
  "rmdir",
  "mv",
  "ln",
  "install",
  "truncate",
  "unlink",
  "shred",
  "mkfifo",
  "remove-item",
]);
const AFTER_FIRST = new Set(["chmod", "chown", "chgrp"]);
const PS_PATH = new Set(["set-content", "add-content", "clear-content"]);

const isFlag = (a: string): boolean => a.startsWith("-") && a.length > 1;

/** Redirect targets and the file arguments of the commands that write; anything the shell would expand is flagged by `unresolved`. */
export function shellTargets(sub: Subcommand, fallbackCwd: string): Target[] {
  const cwd = sub.cwd ?? fallbackCwd;
  const out: Target[] = [];
  for (const { op, target } of sub.redirects ?? []) {
    if (/^nul$/i.test(target)) continue;
    out.push({ access: op.startsWith("<") ? "read" : "edit", path: target, cwd });
  }
  const name = (sub.argv[0] ?? "").toLowerCase();
  const args = sub.argv.slice(1);
  let positional = args.filter((a) => !isFlag(a));
  const edit = (paths: string[]): void => {
    for (const path of paths) out.push({ access: "edit", path, cwd });
  };
  const dir = ["cp", "mv", "ln", "install"].includes(name) ? targetDirectory(args) : undefined;
  if (dir !== undefined) {
    edit([dir]);
    positional = positional.filter((p) => p !== dir);
    if (name === "cp") for (const path of positional) out.push({ access: "read", path, cwd });
    else edit(positional);
  } else if (EVERY_ARG.has(name)) edit(positional);
  else if (AFTER_FIRST.has(name)) edit(positional.slice(1));
  else if (name === "cp") {
    for (const path of positional.slice(0, -1)) out.push({ access: "read", path, cwd });
    edit(positional.slice(-1));
  } else if (name === "sed") {
    const inPlace = args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a));
    const scripted = args.some((a) => /^(-[a-zA-Z]*[ef]|--expression|--file)/.test(a));
    if (inPlace) edit(scripted ? positional : positional.slice(1));
  } else if (name === "dd") edit(args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
  else if (PS_PATH.has(name)) {
    const at = args.findIndex((a) => /^-(literal)?path$/i.test(a));
    edit(at >= 0 ? [args[at + 1] ?? ""] : positional.slice(0, 1));
  }
  return out;
}

function targetDirectory(args: string[]): string | undefined {
  for (const [i, a] of args.entries()) {
    const long = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (long !== null && "target-directory".startsWith(long[1] ?? "x") && (long[1] ?? "").startsWith("t"))
      return long[2] ?? args[i + 1];
    const short = /^-[a-zA-Z]*?t(.*)$/.exec(a);
    if (short !== null) return short[1] === "" ? args[i + 1] : short[1];
  }
  return undefined;
}

const SAFE_SED = /^(?:[\d$,]*\s*(?:s([/|#,:@])(?:(?!\1).)*\1(?:(?!\1).)*\1[gpiIm\d]*|[pdq])\s*;?\s*)+$/;

/** True unless every script is plain `s///`, `p`, `d` or `q` commands: `e`, `w`, `W`, `r` and script files can run commands or write files. */
export function sedEscapes(args: string[]): boolean {
  if (args.some((a) => /^(-[a-zA-Z]*f|--file)/.test(a))) return true;
  const isE = (a: string | undefined): boolean => /^(-[a-zA-Z]*e|--expression)$/.test(a ?? "");
  const scripts = args.some((a) => isE(a) || /^--expression=/.test(a))
    ? [
        ...args.filter((_, i) => isE(args[i - 1])),
        ...args.filter((a) => /^--expression=/.test(a)).map((a) => a.slice(13)),
      ]
    : args.filter((a) => !isFlag(a)).slice(0, 1);
  return scripts.length === 0 || !scripts.every((s) => SAFE_SED.test(s));
}

export const unresolvedTarget = (path: string): boolean => /[*?[{$`~]/.test(path);

export const NETWORK_PATH = /^(?:\\\\|\/\/)[^\\/]|^\/net\/[^/]/;

/** Stands for the words xargs reads from its input: anything, so every check treats it as unresolved. No space, so `cmd /c`'s re-split keeps it one word. */
export const XARGS_INPUT = "$(xargs-input)";

/** The strings `-I R`, `-i[R]` and `--replace[=R]` could set, read every way (an `I` or `i` in any option cluster). */
function replaceStrings(opts: string[]): string[] {
  const out = new Set<string>();
  for (const [i, o] of opts.entries()) {
    if (o.startsWith("--r")) {
      const eq = o.indexOf("=");
      out.add(eq < 0 ? "{}" : o.slice(eq + 1));
    } else if (/^-[^-]/.test(o)) {
      const big = o.indexOf("I");
      const small = o.indexOf("i");
      if (big > 0) out.add(big < o.length - 1 ? o.slice(big + 1) : (opts[i + 1] ?? ""));
      if (small > 0) out.add(small < o.length - 1 ? o.slice(small + 1) : "{}");
    }
  }
  return [...out].filter((r) => r !== "");
}

/** The commands `xargs` runs with its input in place: appended, and in every word holding a replace string. */
export function xargsRuns(argv: string[]): string[][] {
  const out: string[][] = [];
  for (const s of xargsCommandStarts(argv).starts) {
    const cmd = argv.slice(s);
    out.push([...cmd, XARGS_INPUT]);
    const reps = replaceStrings(argv.slice(1, s));
    if (reps.length > 0) out.push(cmd.map((w) => (reps.some((r) => w.includes(r)) ? XARGS_INPUT : w)));
  }
  return out;
}

/** The start paths of `find` (`.` when it names none), past its leading options (GNU `-H -L -P -D -O`, BSD `-E -s -x -X -d -f`). */
export function findStarts(argv: string[]): string[] {
  const out: string[] = [];
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-D" || a === "-f") {
      const v = argv[++i];
      if (a === "-f" && v !== undefined) out.push(v);
    } else if (a !== "--" && !/^-([HLPEXsxd]+|O\d*)$/.test(a)) break;
  }
  for (; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (/^[-(!),]|^\\\(/.test(a)) break;
    out.push(a);
  }
  return out.length > 0 ? out : ["."];
}

// A test that picks files by name or place; without one, or past an `-o`, `!` or `,`, find removes everything under its start paths.
const NARROWING = /^-(i?name|i?path|i?wholename|i?regex|i?lname|samefile|inum|empty)$/;
const WIDENING = /^(-o|-or|!|-not|,)$/;

/** What `find -delete` and `find -exec rm … {}` remove, as removal commands: each start path, or what's under it. */
export function findRemovals(argv: string[]): string[][] {
  const all = !argv.some((a) => NARROWING.test(a)) || argv.some((a) => WIDENING.test(a));
  // An unset `$DIR` start leaves find in the working directory.
  const starts = findStarts(argv).flatMap((s) => (/[$`]/.test(s) ? [s, "."] : [s]));
  const reach = starts.map((s) => (all || /[$`]/.test(s) ? s : `${s.replace(/[\\/]+$/, "")}/*`));
  const out = argv.includes("-delete") ? [["rm", "-r", ...reach]] : [];
  for (const [name = "", ...args] of findCommands(argv))
    if (args.some((a) => a.includes("{}")))
      out.push(...reach.map((r) => [commandName(name), ...args.map((a) => a.replaceAll("{}", r))]));
  return out;
}
