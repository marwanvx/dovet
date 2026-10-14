// What both shell analyzers share: the options, the findings so far, and path checks against the working directories.
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Subcommand } from "../rules/index.ts";
import type { Word } from "./read-only.ts";

export type AnalyzeOptions = {
  cwd: string;
  workingDirs: readonly string[];
  home?: string;
  /** Expands an unquoted glob in `cwd`; matches are relative to it unless the pattern is absolute. */
  glob(pattern: string, cwd: string, deadline?: number): string[];
  isDirectory(path: string): boolean;
  /** Parser time allowed, in ms (permissions §4.0 item 7). */
  budgetMs?: number;
};

export type Operand = { access: "read" | "edit"; path: string };

export type Analysis = {
  /** Every simple command found, in order, including inside `$( )`, loops and `sh -c`; undefined when the text could not be parsed at all. */
  commands: Subcommand[] | undefined;
  /** Every syntax node is on the allowlist (permissions §4.0 item 1): allow rules and read-only status may apply. */
  understood: boolean;
  /** Every command-name position is literal: the lower bar of sandbox auto-allow. */
  literalNames: boolean;
  reasons: string[];
  /** File operands of read-only commands, glob matches included, resolved against the simulated cwd. */
  operands: Operand[];
};

export const MAX_COMMAND_CHARS = 10_000;
export const MAX_GLOB_MATCHES = 1000;

export type Context = ReturnType<typeof createContext>;

export function createContext(opts: AnalyzeOptions) {
  const commands: Subcommand[] = [];
  const operands: Operand[] = [];
  const reasons: string[] = [];
  const state = { literalNames: true };
  const deadline = { at: Number.POSITIVE_INFINITY };
  const fail = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const toAbsolute = (path: string, cwd: string): string => {
    if (opts.home !== undefined && (path === "~" || path.startsWith("~/"))) return resolve(opts.home, path.slice(2));
    return resolve(cwd, path);
  };
  const tildeOk = (path: string): boolean =>
    !path.startsWith("~") || (opts.home !== undefined && (path === "~" || path.startsWith("~/")));
  const inside = (abs: string): boolean =>
    opts.workingDirs.some((dir) => {
      const rel = relative(dir, abs);
      return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
    });
  /** Resolves a file operand, expanding a glob. False when any path leaves the working directories, is a UNC path, or a glob matches too much. */
  const checkPaths = (words: Word[], cwd: string, access: Operand["access"]): boolean => {
    let ok = true;
    for (const w of words) {
      if (performance.now() > deadline.at) {
        fail("analysis budget exceeded");
        return false;
      }
      if (!tildeOk(w.text)) {
        fail(`unresolvable ${w.text}`);
        ok = false;
        continue;
      }
      if (/^(\\\\|\/\/)[^\\/]/.test(w.text)) {
        fail("UNC path");
        ok = false;
        continue;
      }
      let names = w.values ?? [w.text];
      if (w.glob) {
        const base = w.text.split("/").findIndex((p) => /[*?[{]/.test(p));
        const root = toAbsolute(w.text.split("/").slice(0, Math.max(base, 0)).join("/") || ".", cwd);
        if (!inside(root)) {
          operands.push({ access, path: root });
          ok = false;
          continue;
        }
        const matches = opts.glob(w.text, cwd, deadline.at);
        if (performance.now() > deadline.at) {
          fail("analysis budget exceeded");
          return false;
        }
        if (matches.length > MAX_GLOB_MATCHES) {
          fail(`glob ${w.text} matches more than ${MAX_GLOB_MATCHES} files`);
          ok = false;
          continue;
        }
        if (matches.length > 0) names = matches;
      }
      for (const name of names) {
        const path = toAbsolute(name, cwd);
        operands.push({ access, path });
        if (!inside(path)) ok = false;
      }
    }
    return ok;
  };
  return {
    opts,
    commands,
    operands,
    reasons,
    state,
    deadline,
    fail,
    toAbsolute,
    tildeOk,
    inside,
    checkPaths,
  };
}
