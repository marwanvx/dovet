// Critical-path removals (permissions §4.4): a circuit breaker against model error that no allow rule can lift.
import { posix, win32 } from "node:path";
import { isWithin, pathKey } from "../../platform/index.ts";
import type { Subcommand } from "../rules/index.ts";
import { type Env, resolveForms } from "./paths.ts";

const REMOVERS = new Set(["rm", "rmdir", "remove-item", "rd", "del", "erase"]);
const VAR = String.raw`\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|\d)`;
const TOP =
  "usr|etc|var|bin|sbin|lib|lib64|opt|home|root|mnt|tmp|boot|srv|dev|sys|proc|Users|Windows|Applications|System|Library|Volumes";
const MAC_PRIVATE = ["/private/etc", "/private/var", "/private/tmp", "/private/home"];

const targets = (sub: Subcommand): string[] => {
  const cmdSwitches = ["rd", "del", "erase"].includes(sub.argv[0]?.toLowerCase() ?? "");
  return sub.argv
    .slice(1)
    .filter((a) => !(a.startsWith("-") && a.length > 1) && !(cmdSwitches && /^\/[a-z]$/i.test(a)));
};

/** `cmd /c rd /s C:\x` as the command it runs. */
export function unwrapCmd(sub: Subcommand): Subcommand {
  const [name = "", flag = "", ...rest] = sub.argv;
  if (!/^cmd(\.exe)?$/i.test(name) || !/^\/[ck]$/i.test(flag)) return sub;
  return { ...sub, argv: rest.flatMap((a) => a.split(/\s+/).filter(Boolean)) };
}

function isRootOrTop(env: Env, p: string): boolean {
  const impl = env.os === "win32" ? win32 : posix;
  const root = impl.parse(p).root;
  if (pathKey(p, env.os) === pathKey(root, env.os) || pathKey(impl.dirname(p), env.os) === pathKey(root, env.os))
    return true;
  return env.os === "darwin" && MAC_PRIVATE.includes(p.toLowerCase());
}

function homes(env: Env): string[] {
  const forms = resolveForms(env, env.home, env.cwd);
  return forms === undefined ? [env.home] : [forms.requested, forms.canonical];
}

function listCritical(env: Env, p: string, glob: boolean): boolean {
  const same = (q: string) => pathKey(p, env.os) === pathKey(q, env.os);
  if (isRootOrTop(env, p) || homes(env).some(same)) return true;
  return env.workingDirs.some((d) => (same(d) && !glob) || (!same(d) && isWithin(d, p, env.os)));
}

/** Why one removal target is critical, else undefined. */
function criticalTarget(env: Env, raw: string, cwd: string, recursive: boolean): string | undefined {
  let t = raw.replace(/["']/g, "");
  if (/^\\+$/.test(t)) return "a backslash-only target";
  if (/^[\\/]{2}[^\\/]+[\\/][A-Za-z]\$/.test(t)) return "an administrative share";
  const subst = t.search(/\$\(|`/);
  if (subst >= 0) {
    if (recursive && /^(\$\(.*\)|`[^`]*`)$/s.test(t))
      return "a recursive removal whose target is only a command substitution";
    const head = t.slice(0, subst).replace(/\/$/, "");
    return head !== "" && criticalTarget(env, head, cwd, recursive) !== undefined
      ? "a critical path followed by a substitution"
      : undefined;
  }
  const variable = new RegExp(`^(${VAR})(.*)$`, "s").exec(t);
  if (variable !== null) {
    const [, name = "", rest = ""] = variable;
    if (/^\$\{?HOME\}?$/.test(name)) t = env.home + rest;
    else if (/^[/\\]?\*?$/.test(rest) && rest !== "") return "a glob or trailing slash directly under a shell variable";
    else
      return new RegExp(`^/(${TOP})(/|$)`).test(rest)
        ? "a shell variable followed by a top-level directory"
        : undefined;
  } else if (t === "~" || t.startsWith("~/")) t = env.home + t.slice(1);
  if (t.includes("$")) return undefined;
  if (t.startsWith("/cygdrive/")) t = t.slice(9);
  const glob = /[*?[{]/.test(t);
  let base = t;
  if (glob) {
    const parts = t.split(/[\\/]/);
    const at = parts.findIndex((s) => /[*?[{]/.test(s));
    base = parts.slice(0, at).join("/");
    if (base === "") base = t.startsWith("/") || t.startsWith("\\") ? "/" : ".";
    else if (/^[A-Za-z]:$/.test(base)) base += "/";
  }
  const forms = resolveForms(env, base, cwd);
  if (forms === undefined) return "a network or device path";
  return [forms.requested, forms.canonical].some((p) => listCritical(env, p, glob)) ? "a critical path" : undefined;
}

const recursiveFlag = (sub: Subcommand): boolean =>
  sub.argv.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive" || /^-recurse$/i.test(a));

/** The reason a removal command targets a critical path, else undefined. */
export function criticalRemoval(env: Env, sub: Subcommand): string | undefined {
  if (!REMOVERS.has(sub.argv[0]?.toLowerCase() ?? "")) return undefined;
  const recursive = recursiveFlag(sub);
  for (const t of targets(sub)) {
    const why = criticalTarget(env, t, sub.cwd ?? env.cwd, recursive);
    if (why !== undefined) return `${t}: ${why}`;
  }
  return undefined;
}

/** PowerShell `Remove-Item` of a system path or a bare wildcard: denied in every mode (§4.4). */
export function systemRemoval(env: Env, sub: Subcommand): string | undefined {
  if (!["remove-item", "rd", "rmdir", "del", "erase"].includes(sub.argv[0]?.toLowerCase() ?? "")) return undefined;
  for (const t of targets(sub)) {
    const bare = t.replace(/["']/g, "");
    if (bare === "*" || bare === "/*" || bare === "\\*") return `${t}: a bare wildcard`;
    if (/[$`*?]/.test(bare)) continue;
    const forms = resolveForms(env, bare, sub.cwd ?? env.cwd);
    if (forms !== undefined && [forms.requested, forms.canonical].some((p) => isRootOrTop(env, p)))
      return `${t}: a system path`;
  }
  return undefined;
}
