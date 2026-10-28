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

// cmd's remover switches, run together too (`/s/q`); only `/a` takes a value, attribute letters.
const CMD_SWITCH_RUN = /^(?:\/[a-z](?::?[-rhsailo]*)?)+$/i;
const CMD_REMOVERS = ["rd", "rmdir", "del", "erase"];

const targets = (sub: Subcommand): string[] => {
  const cmdSwitches = CMD_REMOVERS.includes(sub.argv[0]?.toLowerCase() ?? "");
  return sub.argv
    .slice(1)
    .filter((a) => !(a.startsWith("-") && a.length > 1) && !(cmdSwitches && CMD_SWITCH_RUN.test(a)));
};

const CMD_SWITCH = /^(?:\/(?![ckr])[a-z](?::[^/\s]*)?)+$/i;
const CMD_RUN = /^(?:\/(?![ckr])[a-z](?::[^/\s]*)?)*\/[ckr](.*)$/is;

/** The words after `cmd`'s `/c` (or its `/r` synonym) or `/k`, past its other switches (`/d /q /c`); cmd also takes the command glued on (`/crd`, `/q/c`). */
function cmdOperand(argv: string[]): string[] | undefined {
  for (let i = 1; i < argv.length; i++) {
    const run = CMD_RUN.exec(argv[i] ?? "");
    if (run !== null) return run[1] === "" || run[1] === undefined ? argv.slice(i + 1) : [run[1], ...argv.slice(i + 1)];
    if (!CMD_SWITCH.test(argv[i] ?? "")) return undefined;
  }
  return undefined;
}

/** The command cmd runs for these words: its first word ends at `,` `;` `=` like at a space, `call` runs the rest,
 * and a program takes its switch glued on (`call,start/b git push` runs `start /b git push`). */
function cmdHead(words: string[]): string[] {
  let out = words;
  for (;;) {
    const [first = "", ...rest] = out;
    const parts = first === "" ? [first] : first.split(/[\s,;=]+/).filter(Boolean);
    // A name ends at `/` (`schtasks/create`, `rd/s/q`); `call` and `start` end at `.` `+` `:` `[` `]` `\` too.
    const glued =
      /^([a-z][\w.-]*)(\/.*)$/is.exec(parts[0] ?? "") ?? /^(call|start)[.+:[\]\\](.+)$/is.exec(parts[0] ?? "");
    if (glued !== null) parts.splice(0, 1, glued[1] ?? "", glued[2] ?? "");
    out = [...parts, ...rest];
    if (out[0]?.toLowerCase() !== "call") return out;
    out = out.slice(1);
  }
}

/** `cmd /c call cmd /c rd /s C:\x` as the command it runs, every `cmd` layer and `call` peeled (the same sub when it
 * is not a `cmd` wrapper). */
export function unwrapCmd(sub: Subcommand): Subcommand {
  while (commandName(sub.argv[0]) === "cmd") {
    const rest = cmdOperand(sub.argv);
    if (rest === undefined) return sub;
    // One word is the whole command line as cmd received it: re-split it. Several words were already split by the
    // calling shell — a word keeping its spaces is one argument of the command (`find "/my dir" -delete`).
    sub = { ...sub, argv: cmdHead(rest.length === 1 ? (rest[0] ?? "").split(/\s+/).filter(Boolean) : rest) };
  }
  return sub;
}

const CMD_META = /[\^"&|;()<>%@!]/;

/** Whether the words after this `cmd /c` operand's switches could be read by cmd other than as they stand: a
 * metacharacter (caret escapes, quote toggling, `&`/`|`/`()`/`<>` separators and redirections, `@` echo-off, `!`
 * delayed expansion, `%VAR%` expansion), an empty word (a quote pair bash consumed that cmd's leading-quote rules
 * still see), or — when several words follow the switch — a first word holding whitespace, so the program itself
 * arrived quoted and cmd's leading-quote rules decide what it runs. One word is the whole line cmd re-splits
 * honestly, and later words keep their spaces honestly (the spawn re-quotes them, the child's argv keeps them).
 * The xargs stand-in is Dovet's own word, not cmd's. */
export function cmdOperandUnsafe(argv: string[]): boolean {
  if (commandName(argv[0]) !== "cmd") return false;
  const words = cmdOperand(argv);
  if (words === undefined) return false;
  return words.some(
    (a, j) => a !== XARGS_INPUT && (a === "" || CMD_META.test(a) || (words.length > 1 && j === 0 && /\s/.test(a))),
  );
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
  t = t.replace(/^~\+0(?=$|[/\\])/, "~+");
  const elsewhere = /^(~(?:[+-]\d+|-|[^/\\$+\s][^/\\$\s]*)|\$OLDPWD|\$\{OLDPWD\})((?:[/\\].*)?)$/s.exec(t);
  if (elsewhere !== null) {
    // Unresolvable: critical when the rest names the directory itself, a glob directly under it, or climbs out of it.
    const rel = posix.normalize(`.${(elsewhere[2] ?? "").replace(/\\/g, "/")}`).replace(/\/+$/, "");
    return rel === "." || rel === ".." || rel.startsWith("../") || /^[^/]*[*?[{]/.test(rel)
      ? "another user's home, the previous directory or a directory-stack entry, which the check can't resolve"
      : undefined;
  }
  const variable = new RegExp(`^(${VAR})(.*)$`, "s").exec(t);
  if (variable !== null) {
    const [, name = "", rest = ""] = variable;
    // PowerShell names are case-insensitive (`$pwd`, `$Home`).
    if (/^\$\{?HOME\}?$/i.test(name)) t = env.home + rest;
    else if (/^\$\{?PWD\}?$/i.test(name)) t = cwd + rest;
    else if (/^[/\\]?\*?$/.test(rest) && rest !== "") return "a glob or trailing slash directly under a shell variable";
    else
      return new RegExp(`^/(${TOP})(/|$)`).test(rest)
        ? "a shell variable followed by a top-level directory"
        : undefined;
  } else if (t === "~" || t.startsWith("~/")) t = env.home + t.slice(1);
  else if (t === "~+" || t.startsWith("~+/")) t = cwd + t.slice(2);
  if (t.includes("$"))
    return /^\$\{?(?:HOME|PWD|OLDPWD)(?!\w)/i.test(orig)
      ? "the home, working or previous directory with an expansion the check can't resolve"
      : undefined;
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

// xargs input can carry the flag itself (`echo '-rf /' | xargs rm`); only `rm` stops reading flags at `--`, cmd's
// removers take `/s` anywhere.
function recursiveFlag(sub: Subcommand): boolean {
  const name = sub.argv[0]?.toLowerCase() ?? "";
  const cmdSwitches = CMD_REMOVERS.includes(name);
  const end = name === "rm" ? sub.argv.indexOf("--") : -1;
  return sub.argv.some(
    (a, i) =>
      /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) ||
      a === "--recursive" ||
      /^-recurse$/i.test(a) ||
      (cmdSwitches && CMD_SWITCH_RUN.test(a) && /\/s(?=\/|$)/i.test(a)) ||
      (a === XARGS_INPUT && (end < 0 || i < end)),
  );
}

/** The reason a removal command targets a critical path, else undefined. */
export function criticalRemoval(env: Env, sub: Subcommand): string | undefined {
  if (!REMOVERS.has(sub.argv[0]?.toLowerCase() ?? "")) return undefined;
  const recursive = recursiveFlag(sub);
  const fromInput = recursive && !recursiveFlag({ ...sub, argv: sub.argv.filter((a) => a !== XARGS_INPUT) });
  const rewrite = sub.argv[0] === "rm" ? " (`xargs rm --` keeps the input to file names)" : "";
  const note = fromInput ? `, and the xargs input can carry its flags${rewrite}` : "";
  for (const t of targets(sub)) {
    const why = criticalTarget(env, t, sub.cwd ?? env.cwd, recursive);
    if (why !== undefined) return `${t}: ${why}${note}`;
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
