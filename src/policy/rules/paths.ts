// Path rule patterns: gitignore syntax anchored per permissions §3.3, matched against both spelling and canonical target.
import ignore from "ignore";
import type { Os } from "../../platform/index.ts";
import { lexicalPath, PathRefused } from "../../platform/index.ts";

export type PathContext = { os: Os; home: string; canonicalize(abs: string): string };

export type PathMatcher = {
  negate: boolean;
  /** Absolute directories (POSIX form) the pattern is anchored under; undefined = the call's working directory. */
  roots: string[] | undefined;
  floating: boolean;
  test(rel: string): boolean;
};

export const toPosix = (p: string, os: Os): string =>
  os === "win32" ? p.replaceAll("\\", "/").replace(/^([A-Za-z]):(?=\/|$)/, (_, d: string) => `/${d.toLowerCase()}`) : p;

const fromPosix = (p: string, os: Os): string => (os === "win32" ? lexicalPath(p, "C:\\", os) : p);

function bracketsBalanced(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "\\") i++;
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) return false;
      i = end;
    }
  }
  return true;
}

const escapeLiteral = (s: string): string => s.replace(/[\\[\]*?!#]/g, "\\$&");
const GLOB = /[*?[\\]/;
const SINGLE_DIR = /^[^/]+\/(?:\*\*)?$/;

/** Compiles one path rule specifier; `warning` is set when it was dropped or changed. */
export function compilePath(
  spec: string,
  behavior: "allow" | "ask" | "deny",
  baseDir: string,
  c: PathContext,
): { matcher?: PathMatcher; warning?: string } {
  const negate = spec.startsWith("!");
  if (negate && behavior === "allow") return { warning: "! negation only works in deny and ask rules" };
  let s = negate ? spec.slice(1) : spec;
  if (c.os === "win32")
    s = s.replaceAll("\\", "/").replace(/^\/{0,2}([A-Za-z]):(?=\/|$)/, (_, d: string) => `//${d.toLowerCase()}`);
  let abs: string | undefined;
  if (s.startsWith("//")) abs = s.slice(1);
  else if (s.startsWith("~/") || s === "~") abs = toPosix(c.home, c.os).replace(/\/$/, "") + s.slice(1);
  else if (s.startsWith("/")) abs = toPosix(baseDir, c.os).replace(/\/$/, "") + s;
  const valid = bracketsBalanced(s);
  if (!valid && behavior === "allow") return { warning: "the pattern can't be compiled, so the rule is ignored" };
  const fold = c.os !== "linux";
  const make = (pattern: string, roots: string[] | undefined, floating: boolean): PathMatcher => {
    const ig = ignore({ ignorecase: fold }).add(pattern);
    return { negate, roots, floating, test: (rel) => ig.ignores(rel) };
  };
  if (abs !== undefined) {
    const trailing = abs.length > 1 && abs.endsWith("/");
    const segs = (trailing ? abs.slice(0, -1) : abs).split("/");
    let idx = segs.findIndex((seg) => GLOB.test(seg));
    if (idx < 0 || idx > segs.length - 1) idx = segs.length - 1;
    if (!valid) idx = segs.findIndex((seg) => !bracketsBalanced(seg));
    const dir = segs.slice(0, idx).join("/") || "/";
    let tail = segs.slice(idx).join("/");
    if (!valid) tail = escapeLiteral(tail);
    const canon = toPosix(c.canonicalize(fromPosix(dir, c.os)), c.os);
    return { matcher: make(`/${tail}${trailing ? "/" : ""}`, [...new Set([dir, canon])], false) };
  }
  let pattern = valid ? s : escapeLiteral(s);
  if (valid && s.startsWith("./")) pattern = s.slice(1);
  else if (valid && SINGLE_DIR.test(s)) pattern = behavior === "allow" ? `/${s}` : `**/${s}`;
  return { matcher: make(pattern, undefined, !pattern.startsWith("/")) };
}

function under(path: string, root: string, fold: boolean): string | undefined {
  const p = fold ? path.toLowerCase() : path;
  const r = (fold ? root.toLowerCase() : root).replace(/\/$/, "");
  if (p === r) return undefined;
  return p.startsWith(`${r}/`) ? path.slice(r.length + 1) : undefined;
}

/** Does the rule match one path (POSIX form)? `cwds` are the working directory's spellings. */
export function pathMatches(m: PathMatcher, path: string, cwds: string[], os: Os): boolean {
  const roots = m.roots ?? (m.floating ? [...cwds, "/"] : cwds);
  return roots.some((root) => {
    const rel = under(path, root, os !== "linux");
    return rel !== undefined && rel !== "" && m.test(rel);
  });
}

export type PathForms = { requested: string; canonical: string };

/** The spellings of a call path, or undefined when the path is refused (it can't be judged here). */
export function pathForms(path: string, cwd: string, c: PathContext): PathForms | undefined {
  try {
    const lexical = lexicalPath(path, cwd, c.os);
    return { requested: toPosix(lexical, c.os), canonical: toPosix(c.canonicalize(lexical), c.os) };
  } catch (e) {
    if (e instanceof PathRefused) return undefined;
    throw e;
  }
}
