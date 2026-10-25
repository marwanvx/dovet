// Critical-path removals (permissions §4.4): a circuit breaker against model error that no allow rule can lift.
import { posix, win32 } from "node:path";
import { isWithin, pathKey } from "../../platform/index.ts";
import { commandName, type Subcommand } from "../rules/index.ts";
import { type Env, resolveForms } from "./paths.ts";
import { XARGS_INPUT } from "./targets.ts";

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

/** `cmd /c cmd /c rd /s C:\x` as the command it runs, every `cmd` layer peeled (the same sub when it is not a `cmd` wrapper). */
export function unwrapCmd(sub: Subcommand): Subcommand {
  while (commandName(sub.argv[0]) === "cmd") {
    // `cmd /d /q /c …`: other switches may come before /c or /k.
    let i = 1;
    while (i < sub.argv.length && /^\/[a-z](:\S*)?$/i.test(sub.argv[i] ?? "") && !/^\/[ck]$/i.test(sub.argv[i] ?? ""))
      i++;
    if (!/^\/[ck]$/i.test(sub.argv[i] ?? "")) return sub;
    const rest = sub.argv.slice(i + 1);
    // One word is the whole command line as cmd received it: re-split it. Several words were already split by the
    // calling shell — a word keeping its spaces is one argument of the command (`find "/my dir" -delete`).
    sub = { ...sub, argv: rest.length === 1 ? (rest[0] ?? "").split(/\s+/).filter(Boolean) : rest };
  }
  return sub;
}

const CMD_META = /[\^"&|;()<>%]/;

/** Whether the words after this `cmd /c` operand's switches could be read by cmd other than as they stand: a
 * metacharacter (caret escapes, quote toggling, `&`/`|`/`()`/`<>` separators and redirections, `%VAR%` expansion),
 * or — when several words follow the switch — a first word holding whitespace, so the program itself arrived
 * quoted and cmd's leading-quote rules decide what it runs. One word is the whole line cmd re-splits honestly, and
 * later words keep their spaces honestly (the spawn re-quotes them, the child's argv keeps them). The xargs
 * stand-in is Dovet's own word, not cmd's. */
export function cmdOperandUnsafe(argv: string[]): boolean {
  if (commandName(argv[0]) !== "cmd") return false;
  let i = 1;
  while (i < argv.length && /^\/[a-z](:\S*)?$/i.test(argv[i] ?? "") && !/^\/[ck]$/i.test(argv[i] ?? "")) i++;
  if (!/^\/[ck]$/i.test(argv[i] ?? "")) return false;
  const words = argv.slice(i + 1);
  return words.some((a, j) => a !== XARGS_INPUT && (CMD_META.test(a) || (words.length > 1 && j === 0 && /\s/.test(a))));
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
  const orig = t;
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
  if (t.includes("$"))
    return /^\$\{?HOME/.test(orig) ? "the home directory with an expansion the check can't resolve" : undefined;
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
export function systemRemoval(env: Env, sub: Subcommand, viaCmd: boolean): string | undefined {
  const name = sub.argv[0]?.toLowerCase() ?? "";
  if (!(name === "remove-item" || (viaCmd && ["rd", "rmdir", "del", "erase"].includes(name)))) return undefined;
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
