// Glob expansion for file-operand checks (permissions §4.0 item 4); the composition root passes it to `analyzeShell`.
import { isAbsolute, join, resolve } from "node:path";
import { MAX_GLOB_MATCHES } from "./context.ts";

const GLOB_CHARS = /[*?[{]/;

/** Matches of `pattern` in `cwd`, stopping a little past the limit; dot files only when the segment names them. */
export function expandGlob(pattern: string, cwd: string): string[] {
  const parts = pattern.split("/");
  const firstGlob = parts.findIndex((p) => GLOB_CHARS.test(p));
  const base = parts.slice(0, Math.max(firstGlob, 0)).join("/");
  const root = base === "" ? (isAbsolute(pattern) ? "/" : cwd) : resolve(cwd, base);
  const rest = parts.slice(Math.max(firstGlob, 0)).join("/");
  const out: string[] = [];
  const glob = new Bun.Glob(rest);
  for (const match of glob.scanSync({
    cwd: root,
    onlyFiles: false,
    dot: rest.split("/").some((p) => p.startsWith(".")),
  })) {
    out.push(base === "" && !isAbsolute(pattern) ? match : join(base === "" ? "/" : base, match));
    if (out.length > MAX_GLOB_MATCHES) break;
  }
  return out.sort();
}
