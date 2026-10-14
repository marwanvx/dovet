// The files a shell command writes or reads that the analyzer does not already list as operands (permissions §4.0 item 4, §4.5).
import type { Subcommand } from "../rules/index.ts";

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
  const positional = args.filter((a) => !isFlag(a));
  const edit = (paths: string[]): void => {
    for (const path of paths) out.push({ access: "edit", path, cwd });
  };
  if (EVERY_ARG.has(name)) edit(positional);
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

export const unresolvedTarget = (path: string): boolean => /[*?[{$`~]/.test(path);

export const NETWORK_PATH = /^(?:\\\\|\/\/)[^\\/]|^\/net\/[^/]/;
