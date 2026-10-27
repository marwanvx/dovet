// Shell rule text: a stopgap command splitter and wrapper stripping (permissions §3.2) until M1-22 supplies parsed commands.
export type Redirect = { op: string; target: string };
export type Subcommand = {
  argv: string[];
  redirects?: Redirect[];
  /** Set by the analyzer (permissions §4.6): the command only reads, so it needs no allow rule of its own. */
  readOnly?: boolean;
  /** The simulated working directory the command runs in (permissions §4.0 item 5). */
  cwd?: string;
};

const REDIRECT = /^(?:&>>?|>>|>\||>&?|<&?)/;
const SEPARATORS = ["&&", "||", "|&", ";", "|", "&", "\n"];

/** Splits a command into simple commands, or undefined when it holds anything this reader can't take apart exactly. */
export function splitCommand(command: string): Subcommand[] | undefined {
  const out: Subcommand[] = [];
  let cur: Required<Pick<Subcommand, "argv" | "redirects">> = { argv: [], redirects: [] };
  let word: string | undefined;
  let pending: string | undefined;
  const endWord = (): void => {
    if (word === undefined) return;
    if (pending !== undefined) {
      if (!(pending.endsWith("&") && /^(\d+|-)$/.test(word)) && !word.startsWith("&"))
        cur.redirects.push({ op: pending, target: word });
      pending = undefined;
    } else cur.argv.push(word);
    word = undefined;
  };
  const endCommand = (): boolean => {
    endWord();
    if (pending !== undefined) return false;
    if (cur.argv.length > 0) out.push(cur);
    cur = { argv: [], redirects: [] };
    return true;
  };
  for (let i = 0; i < command.length; ) {
    const c = command.charAt(i);
    const rest = command.slice(i);
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let text = "";
      let j = i + 1;
      for (; j < command.length && command.charAt(j) !== '"'; j++) {
        const d = command.charAt(j);
        if (d === "$" && command.charAt(j + 1) === "(") return undefined;
        if (d === "`") return undefined;
        if (d === "\\" && j + 1 < command.length) text += command.charAt(++j);
        else text += d;
      }
      if (j >= command.length) return undefined;
      word = (word ?? "") + text;
      i = j + 1;
    } else if (c === "\\") {
      if (i + 1 >= command.length) return undefined;
      if (command.charAt(i + 1) !== "\n") word = (word ?? "") + command.charAt(i + 1);
      i += 2;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "#" && word === undefined) {
      const nl = command.indexOf("\n", i);
      i = nl < 0 ? command.length : nl;
    } else if (rest.startsWith("<<") || "(){}`".includes(c) || rest.startsWith("$(")) {
      return undefined;
    } else if (REDIRECT.test(rest)) {
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      endWord();
      if (pending !== undefined) return undefined;
      pending = (REDIRECT.exec(rest) ?? [""])[0];
      i += pending.length;
    } else {
      const sep = SEPARATORS.find((s) => rest.startsWith(s));
      if (sep === undefined) {
        word = (word ?? "") + c;
        i++;
      } else {
        if (!endCommand()) return undefined;
        i += sep.length;
        if ((sep === "&&" || sep === "||" || sep === "|") && command.slice(i).trim() === "") return undefined;
      }
    }
  }
  return endCommand() ? out : undefined;
}

type Kind = "none" | "value";
type Grammar = { short: Record<string, Kind>; long: Record<string, Kind>; operands: number; numeric?: boolean };
const NO_OPTIONS: Grammar = { short: {}, long: {}, operands: 0 };

/** The wrappers allow rules see past, with their whole option grammar (GNU coreutils): an option not listed hides the command. */
const SAFE_WRAPPERS = new Map<string, Grammar>([
  [
    "timeout",
    {
      short: { f: "none", p: "none", v: "none", k: "value", s: "value" },
      long: { foreground: "none", "preserve-status": "none", verbose: "none", "kill-after": "value", signal: "value" },
      operands: 1,
    },
  ],
  [
    "time",
    {
      short: { a: "none", p: "none", q: "none", v: "none", f: "value", o: "value" },
      long: { append: "none", portability: "none", quiet: "none", verbose: "none", format: "value", output: "value" },
      operands: 0,
    },
  ],
  ["nice", { short: { n: "value" }, long: { adjustment: "value" }, operands: 0, numeric: true }],
  [
    "stdbuf",
    {
      short: { i: "value", o: "value", e: "value" },
      long: { input: "value", output: "value", error: "value" },
      operands: 0,
    },
  ],
  ["nohup", NO_OPTIONS],
  ["command", NO_OPTIONS],
  ["builtin", NO_OPTIONS],
  ["noglob", NO_OPTIONS],
  ["xargs", NO_OPTIONS],
]);

/** Every wrapper deny and ask rules and the built-in checks see past, with the operands before its command (`flock FILE`). */
const DEEP_WRAPPERS = new Map<string, number>([
  ...[...SAFE_WRAPPERS].map(([name, g]): [string, number] => [name, g.operands]),
  ...[
    "env",
    "sudo",
    "doas",
    "watch",
    "ionice",
    "setsid",
    "exec",
    "busybox",
    "toybox",
    "nsenter",
    "unshare",
    "runuser",
    "strace",
    "ltrace",
    "valgrind",
    "pkexec",
    "fakeroot",
    "systemd-run",
    "numactl",
    "parallel",
    "firejail",
    "prlimit",
    "setpriv",
    "eatmydata",
    "torsocks",
    "proxychains",
    "proxychains4",
    "unbuffer",
    "caffeinate",
    "xvfb-run",
    "dbus-run-session",
    "cgexec",
    "x86_64",
    "linux64",
    "linux32",
    "i386",
    "run0",
    "torify",
    "sem",
    "chpst",
    "arch",
    "sandbox-exec",
    "cpulimit",
    "nocache",
    "trickle",
    "schroot",
    "systemd-nspawn",
  ].map((name): [string, number] => [name, 0]),
  ...[
    "flock",
    "chroot",
    "taskset",
    "su",
    "script",
    "sg",
    "faketime",
    "chrt",
    "setarch",
    "gosu",
    "su-exec",
    "setuidgid",
    "perf",
  ].map((name): [string, number] => [name, 1]),
]);
// chrt's priority and setarch's architecture may be left out.
const OPTIONAL_OPERAND = new Set(["chrt", "setarch"]);
/** Wrappers whose `-c`/`--command` string a shell runs (`su root -c 'cmd'`). */
const SCRIPT_OPTION = new Set(["flock", "su", "runuser", "script", "sg"]);
/** Wrappers that join their command words into one line for `sh -c` (`watch`, `sg group 'a; b'`, `parallel`). */
const JOINED = new Set(["watch", "sg", "parallel", "sem"]);
/** The two launchers whose options may move or rewrite their arguments (decide keeps them to the plain form). */
export const PARALLEL_PROGRAMS = new Set(["parallel", "sem"]);
const PARALLEL_SEPARATOR = /^::::?\+?$/;
/** A replacement string of GNU parallel: `{}`, `{2}`, `{.}`, `{//}`, `{= perl =}`. */
export const PARALLEL_REPLACEMENT = /\{(?:=.*?=|[^{}\s]*)\}/gs;
const MAX_COMBINATIONS = 256;

/** Whether this program runs another command named in its arguments, so a prefix rule on it hands over every command. */
export const isExecWrapper = (name: string): boolean => DEEP_WRAPPERS.has(name);
export const SAFE_ENV = new Set([
  "NODE_ENV",
  "CI",
  "LANG",
  "LC_ALL",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "PYTHONUNBUFFERED",
  "GOOS",
  "GOARCH",
  "DEBUG",
]);
export const isSafeEnv = (name: string): boolean => SAFE_ENV.has(name) || name.startsWith("LC_");
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** `/usr/bin/Git.exe` → `git`: the name a program written as a path runs as. */
export const commandName = (word: string | undefined): string =>
  (word ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();

/** Where a shell's `-c` script is among its arguments (`-lc 'x'`, `-euo pipefail -c 'x'`, `-c -- 'x'`), or -1. */
export function shellScriptAt(args: readonly string[]): number {
  // A word this doesn't understand falls back to the word after the first `-c` cluster.
  const first = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
  const fallback = first < 0 || first + 1 >= args.length ? -1 : first + 1;
  let c = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--" || a === "-") return c && i + 1 < args.length ? i + 1 : fallback;
    if (a === "--rcfile" || a === "--init-file") i++;
    else if (/^[-+][A-Za-z]+$/.test(a)) {
      c ||= a.startsWith("-") && a.includes("c");
      i += (a.slice(1).match(/[oO]/g) ?? []).length;
    } else if (!a.startsWith("--")) return c ? i : fallback;
  }
  return fallback;
}

/** Where the command a safe wrapper runs starts, read with its exact grammar, or undefined when an option isn't in it. */
function safeCommandAt(argv: string[], g: Grammar): number | undefined {
  let i = 1;
  for (; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok === "--") {
      i++;
      break;
    }
    if (!tok.startsWith("-") || tok === "-") break;
    if (g.numeric === true && /^-[-+]?\d+$/.test(tok)) continue;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = tok.slice(2, eq < 0 ? undefined : eq);
      const names = Object.keys(g.long);
      // GNU programs take any unambiguous prefix of a long option (`--sig`).
      const matches = names.includes(name) ? [name] : names.filter((n) => name !== "" && n.startsWith(name));
      const kind = matches.length === 1 ? g.long[matches[0] ?? ""] : undefined;
      if (kind === undefined || (kind === "none" && eq >= 0)) return undefined;
      if (kind === "value" && eq < 0) i++;
      continue;
    }
    for (let k = 1; k < tok.length; k++) {
      const c = tok.charAt(k);
      if (!Object.hasOwn(g.short, c)) return undefined;
      if (g.short[c] === "value") {
        if (k === tok.length - 1) i++;
        break;
      }
    }
  }
  i += g.operands;
  return i < argv.length ? i : undefined;
}

/**
 * Every word the command a wrapper runs could start at. Each option is read both as taking the next word and as not,
 * so an option Dovet has no grammar for, or reads with the wrong value kind, can't move the command out of sight.
 */
function commandStarts(
  argv: string[],
  operands: number,
  env: boolean,
  optional = false,
): { starts: number[]; none: boolean } {
  const starts = new Set<number>();
  let none = false;
  const seen = new Set<number>();
  const todo: [number, number][] = [[1, operands]];
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    const [p, left] = next;
    if (p >= argv.length) none = true;
    if (p >= argv.length || seen.has(p * 8 + left)) continue;
    seen.add(p * 8 + left);
    const tok = argv[p] ?? "";
    if (tok === "--") starts.add(p + 1 + left);
    else if ((tok.startsWith("-") && tok.length > 1) || (env && tok === "-")) todo.push([p + 1, left], [p + 2, left]);
    else if (env && ASSIGNMENT.test(tok)) todo.push([p + 1, left]);
    // `flock FILE -c cmd`: options may follow an operand.
    else if (left > 0) {
      todo.push([p + 1, left - 1]);
      if (optional) starts.add(p);
    } else starts.add(p);
  }
  if ([...starts].some((s) => s >= argv.length)) none = true;
  return { starts: [...starts].filter((s) => s < argv.length).sort((a, b) => a - b), none };
}

/** Where the command `xargs` runs could start (every reading of its options), and whether a reading leaves it none. */
export const xargsCommandStarts = (argv: string[]): { starts: number[]; none: boolean } =>
  commandStarts(argv, 0, false);

/** Whether a reading leaves the command `argv` runs to start at `input` or beyond it, so the input can name it. */
export function commandFromInput(argv: string[], input: string): boolean {
  const name = commandName(argv[0]);
  const operands = DEEP_WRAPPERS.get(name);
  const x = argv.indexOf(input);
  if (operands === undefined || x < 0) return false;
  const { starts, none } = commandStarts(argv, operands, name === "env", OPTIONAL_OPERAND.has(name));
  return none || starts.some((s) => s >= x);
}

/** The values an option word could hand over, each with the index after it: attached after `letter`, after `=`, or the next word. */
function optionValues(argv: string[], j: number, letter: string, long: string): [string, number][] {
  const tok = argv[j] ?? "";
  const next = argv[j + 1];
  const following: [string, number][] = next === undefined ? [] : [[next, j + 2]];
  if (tok.startsWith("--")) {
    const eq = tok.indexOf("=");
    const name = tok.slice(0, eq < 0 ? undefined : eq);
    if (name.length < 3 || !long.startsWith(name)) return [];
    return eq >= 0 ? [[tok.slice(eq + 1), j + 1]] : following;
  }
  const at = tok.indexOf(letter, 1);
  if (!tok.startsWith("-") || at < 0) return [];
  return at < tok.length - 1 ? [[tok.slice(at + 1), j + 1], ...following] : following;
}

/** What the words of a wrapper's readings may add up to: far more than any real command's; past it the command asks (decide). */
type Budget = { words: number; complete: boolean };
const MAX_WORDS = 2_000_000;

/** The reading, or nothing once the budget is spent. */
function take(budget: Budget, argv: string[]): string[][] {
  budget.words -= argv.length;
  if (budget.words >= 0) return [argv];
  budget.complete = false;
  return [];
}

const ENV_ESCAPES: Record<string, string> = {
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  "#": "#",
  $: "$",
  "\\": "\\",
};

/** `env -S`'s own splitting (GNU coreutils): whitespace, quotes, `\_` and the other escapes, `#` comments; undefined for a `${VAR}` or an escape it rejects. */
function envSplit(s: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  const end = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (/[ \t\n\v\f\r]/.test(c)) end();
    else if (c === "#" && word === undefined) break;
    else if (c === "$") return undefined;
    else if (c === "'") {
      // Inside single quotes only `\\` and `\'` are escapes.
      let text = "";
      for (i++; i < s.length && s.charAt(i) !== "'"; i++) {
        const d = s.charAt(i);
        const e = s.charAt(i + 1);
        if (d === "\\" && (e === "\\" || e === "'")) text += s.charAt(++i);
        else text += d;
      }
      if (i >= s.length) return undefined;
      word = (word ?? "") + text;
    } else if (c === '"') {
      let text = "";
      for (i++; i < s.length && s.charAt(i) !== '"'; i++) {
        const d = s.charAt(i);
        if (d === "$") return undefined;
        if (d !== "\\") text += d;
        else {
          const e = s.charAt(++i);
          if (e === "c") return undefined;
          const out = e === "_" ? " " : e === '"' || e === "'" ? e : ENV_ESCAPES[e];
          if (out === undefined) return undefined;
          text += out;
        }
      }
      if (i >= s.length) return undefined;
      word = (word ?? "") + text;
    } else if (c === "\\") {
      const e = s.charAt(++i);
      if (e === "c") break;
      if (e === "_") end();
      else {
        const out = e === "'" || e === '"' ? e : ENV_ESCAPES[e];
        if (out === undefined) return undefined;
        word = (word ?? "") + out;
      }
    } else word = (word ?? "") + c;
  }
  end();
  return words;
}

/** `env -S 'a b' c` → `env a b c`: env splits the string and goes on reading its own options from it. */
function splitStrings(argv: string[], j: number, budget: Budget): string[][] {
  return optionValues(argv, j, "S", "--split-string").flatMap(([raw, after]) => {
    const words = envSplit(raw);
    if (words === undefined) {
      budget.complete = false;
      return [];
    }
    return take(budget, [argv[0] ?? "env", ...words, ...argv.slice(after)]);
  });
}

const FIND_EXEC = /^-(exec|execdir|ok|okdir)$/;

/** Every command `find … -exec cmd … ;` runs (to `;`, `+` or the end), with where each `-exec` sits. */
export function findCommandsAt(argv: string[]): Array<{ at: number; cmd: string[] }> {
  const out: Array<{ at: number; cmd: string[] }> = [];
  for (let i = 1; i < argv.length; i++) {
    if (!FIND_EXEC.test(argv[i] ?? "")) continue;
    let end = i + 1;
    // `+` ends the command only right after `{}`.
    while (end < argv.length && argv[end] !== ";" && !(argv[end] === "+" && argv[end - 1] === "{}")) end++;
    if (end > i + 1) out.push({ at: i, cmd: argv.slice(i + 1, end) });
    i = end;
  }
  return out;
}

/** Every command `find … -exec cmd … ;` runs (to `;`, `+` or the end). */
export function findCommands(argv: string[]): string[][] {
  return findCommandsAt(argv).map(({ cmd }) => cmd);
}

/**
 * `parallel CMD ::: a b ::: c` runs CMD once per combination of one argument from each source, appended or put where
 * a replacement string (`{}`, `{2}`, `-I XX`) stands; with no CMD, the combination is the command line.
 */
function parallelCommands(rest: string[], replaces: string[], budget: Budget): string[][] {
  const sep = rest.findIndex((w) => PARALLEL_SEPARATOR.test(w));
  const cmd = sep < 0 ? rest : rest.slice(0, sep);
  const sources: string[][] = [];
  for (const w of sep < 0 ? [] : rest.slice(sep)) {
    if (PARALLEL_SEPARATOR.test(w)) sources.push([]);
    else sources.at(-1)?.push(w);
  }
  const out = cmd.length === 0 ? [] : [[...cmd, ...sources.flat()]];
  let combos: string[][] = [[]];
  for (const src of sources.filter((x) => x.length > 0)) {
    combos = combos.flatMap((c) => src.map((a) => [...c, a]));
    if (combos.length > MAX_COMBINATIONS) {
      budget.complete = false;
      return out;
    }
  }
  if (cmd.length === 0) return sources.every((x) => x.length === 0) ? [] : combos.map((c) => ["sh", "-c", c.join(" ")]);
  if (cmd.some((w) => w.search(PARALLEL_REPLACEMENT) >= 0 || replaces.some((r) => w.includes(r))))
    for (const c of combos) {
      const put = (w: string): string => {
        let x = w.replace(PARALLEL_REPLACEMENT, (m) =>
          /^\{\d+\}$/.test(m) ? (c[Number(m.slice(1, -1)) - 1] ?? "") : c.join(" "),
        );
        for (const r of replaces) x = x.split(r).join(c.join(" "));
        return x;
      };
      out.push(cmd.map(put));
    }
  return out;
}

/** The replacement strings `-I XX` and `--replace[=XX]` set (`{}` when given none). */
const parallelReplaces = (opts: string[]): string[] =>
  opts
    .flatMap((_, j) => [
      ...optionValues(opts, j, "I", "--replace").map(([v]) => v),
      ...(/^--rep/.test(opts[j] ?? "") && !(opts[j] ?? "").includes("=") ? ["{}"] : []),
    ])
    .filter((r) => r !== "");

/** What an exec wrapper may run, read every way its options allow (deny side). */
function wrapperReadings(argv: string[], name: string, operands: number, budget: Budget): string[][] {
  // `command -v x` only prints where x is.
  if (name === "command" && argv.some((a) => /^-[a-zA-Z]*[vV]/.test(a))) return [];
  const out = commandStarts(argv, operands, name === "env", OPTIONAL_OPERAND.has(name)).starts.flatMap((s) =>
    (PARALLEL_PROGRAMS.has(name)
      ? parallelCommands(argv.slice(s), parallelReplaces(argv.slice(0, s)), budget)
      : [argv.slice(s)]
    ).flatMap((r) => take(budget, r)),
  );
  for (let j = 1; j < argv.length && budget.complete; j++) {
    const tok = argv[j] ?? "";
    if (!tok.startsWith("-")) continue;
    if (name === "env") out.push(...splitStrings(argv, j, budget));
    // `flock FILE -c 'cmd'`, `su root --command=cmd`: the shell runs the string.
    if (SCRIPT_OPTION.has(name))
      for (const [script] of [
        ...optionValues(argv, j, "c", "--command"),
        ...(name === "su" || name === "runuser" ? optionValues(argv, j, "c", "--session-command") : []),
      ])
        out.push(["sh", "-c", script]);
  }
  // These hand their words, joined, to `sh -c`: anything but plain characters (quotes, escapes, `;`) is shell syntax.
  if (JOINED.has(name))
    for (const rest of [...out]) if (rest.some((a) => /[^\w./:=@%+,-]/.test(a))) out.push(["sh", "-c", rest.join(" ")]);
  return out;
}

/**
 * The commands inside this one, one wrapper or leading assignment removed. `deep` (deny and ask rules, and every
 * built-in check) also strips exec wrappers and any assignment, knows a wrapper written as a path, reads each wrapper
 * option every way it could be read and looks into `find -exec`; an allow rule only sees through a safe wrapper called
 * by its bare name whose every option it knows.
 */
function inner(argv: string[], deep: boolean, budget: Budget): string[][] {
  let i = 0;
  while (i < argv.length) {
    const name = ASSIGNMENT.exec(argv[i] ?? "")?.[1];
    if (name === undefined || !(deep || isSafeEnv(name))) break;
    i++;
  }
  if (i > 0) return i < argv.length ? [argv.slice(i)] : [];
  if (!deep) {
    const g = SAFE_WRAPPERS.get(argv[0] ?? "");
    const at = g === undefined ? undefined : safeCommandAt(argv, g);
    return at === undefined ? [] : [argv.slice(at)];
  }
  const name = commandName(argv[0]);
  if (name === "find") return findCommands(argv);
  if (name === "git") return [...gitAlias(argv, budget), ...gitRuns(argv).flatMap((r) => take(budget, r))];
  const operands = DEEP_WRAPPERS.get(name);
  return operands === undefined ? [] : wrapperReadings(argv, name, operands, budget);
}

const GIT_OPTION_VALUES = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--attr-source",
  "--shallow-file",
  "--super-prefix",
]);
const MAX_ALIAS_STEPS = 64;

/**
 * git's global options: where the subcommand is, and the configuration `-c`/`--config-env` set, each key as typed
 * with its value (undefined for `--config-env`, whose value comes from the environment).
 */
export function gitInvocation(args: string[]): { at: number; config: Array<[string, string | undefined]> } {
  const config: Array<[string, string | undefined]> = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] ?? "";
    const env = a.startsWith("--config-env=") ? a.slice(13) : a === "--config-env" ? args[++i] : undefined;
    const kv = a === "-c" ? (args[++i] ?? "") : (env ?? "");
    const eq = kv.indexOf("=");
    if (a === "-c") config.push(eq < 0 ? [kv, "true"] : [kv.slice(0, eq), kv.slice(eq + 1)]);
    else if (env !== undefined) config.push([eq < 0 ? kv : kv.slice(0, eq), undefined]);
    else if (GIT_OPTION_VALUES.has(a)) i++;
    else if (!a.startsWith("-")) break;
  }
  return { at: i, config };
}

/** git's split of an alias into words: whitespace outside quotes, `'` and `"` pairs, backslash escapes. */
function splitAlias(s: string): string[] {
  const out: string[] = [];
  let cur: string | undefined;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if (quote === "" && /\s/.test(c)) {
      if (cur !== undefined) out.push(cur);
      cur = undefined;
    } else if (c === "\\" && quote !== "'") cur = (cur ?? "") + (s[++i] ?? "");
    else if ((c === "'" || c === '"') && (quote === "" || quote === c)) {
      quote = quote === "" ? c : "";
      cur ??= "";
    } else cur = (cur ?? "") + c;
  }
  return cur === undefined ? out : [...out, cur];
}

/**
 * What `git <name>` may run when `-c alias.<name>=…` defines it: every step of the chain, each expansion's words in
 * place of the name, or `sh -c` for a `!` alias (with `"$@"` and the arguments, as git runs it). Every step is a
 * reading because whether git runs the command a step names or the alias of that name depends on what is installed
 * (a script such as `git subtree` ships separately, an alias matches any case). The last definition wins, a loop ends
 * the chain, and a chain past the step cap is not fully read.
 */
function gitAlias(argv: string[], budget: Budget): string[][] {
  const out: string[][] = [];
  let v = argv;
  const used = new Set<string>();
  for (let step = 0; ; step++) {
    const { at, config } = gitInvocation(v.slice(1));
    const sub = v[at + 1]?.toLowerCase() ?? "";
    const value = config.findLast(([k, x]) => x !== undefined && k.toLowerCase() === `alias.${sub}`)?.[1];
    if (value === undefined || used.has(sub)) return out;
    if (step >= MAX_ALIAS_STEPS) {
      budget.complete = false;
      return out;
    }
    used.add(sub);
    const rest = v.slice(at + 2);
    if (value.startsWith("!")) {
      const body = value.slice(1);
      return [
        ...out,
        ...take(budget, rest.length === 0 ? ["sh", "-c", body] : ["sh", "-c", `${body} "$@"`, body, ...rest]),
      ];
    }
    v = [...v.slice(0, at + 1), ...splitAlias(value), ...rest];
    out.push(...take(budget, v));
  }
}

/** `--long=v`, `--long v` and (with `short`) `-xv`, `-x v`, `-ix v` among a git subcommand's options. */
export function gitOptionValues(args: string[], short: string | undefined, long: string): string[] {
  const out: string[] = [];
  for (let j = 0; j < args.length && args[j] !== "--"; j++)
    if ((args[j] ?? "").startsWith("-") && (short !== undefined || (args[j] ?? "").startsWith("--")))
      // parse-options takes the next word only for a bare option, never after an attached value.
      out.push(
        ...optionValues(args, j, short ?? "\0", long)
          .slice(0, 1)
          .map(([v]) => v),
      );
  return out;
}

const SCRIPT_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{", "time"]);

/** `sh -c script`, and each command of the script split at shell separators for an analyzer that doesn't parse
 * `sh -c` (PowerShell). */
const scriptReadings = (script: string): string[][] => [
  ["sh", "-c", script],
  ...script
    .split(/\$\(|[;&|\n(){}`]/)
    .map((part) => {
      const words = splitAlias(part);
      while (SCRIPT_KEYWORDS.has(words[0] ?? "")) words.shift();
      return words;
    })
    .filter((w) => w.length > 0),
];

const shellReadings = (cmd: string[]): string[][] => (cmd.length === 0 ? [] : [cmd, ...scriptReadings(cmd.join(" "))]);

/** What a git subcommand runs from its own arguments: `submodule foreach`, `bisect run`, `rebase --exec`, a pager,
 * difftool or upload-pack program, or the git command `for-each-repo` runs in each repository. */
function gitRuns(argv: string[]): string[][] {
  const { at } = gitInvocation(argv.slice(1));
  const sub = argv[at + 1] ?? "";
  const rest = argv.slice(at + 2);
  const sh = (values: string[]): string[][] => values.flatMap(scriptReadings);
  switch (sub) {
    case "submodule":
    case "submodule--helper": {
      const f = rest.findIndex((a) => !a.startsWith("-"));
      if (rest[f] !== "foreach") return [];
      const cmd = rest.slice(f + 1);
      const start = cmd.findIndex((a) => !a.startsWith("-") || a === "--");
      return shellReadings(start < 0 ? [] : cmd.slice(cmd[start] === "--" ? start + 1 : start));
    }
    case "bisect":
      return rest[0] === "run" ? shellReadings(rest.slice(1)) : [];
    case "rebase":
      return sh(gitOptionValues(rest, "x", "--exec"));
    case "difftool":
      return sh(gitOptionValues(rest, "x", "--extcmd"));
    case "grep":
      // `-O` takes its pager only attached; alone it opens the configured one.
      return sh(
        rest.flatMap((a) =>
          /^-[^-O]*O./s.test(a)
            ? [a.slice(a.indexOf("O") + 1)]
            : isLongOption("--open-files-in-pager", a) && a.includes("=")
              ? [a.slice(a.indexOf("=") + 1)]
              : [],
        ),
      );
    case "fetch":
    case "pull":
      return sh(gitOptionValues(rest, undefined, "--upload-pack"));
    case "clone":
      return sh(gitOptionValues(rest, "u", "--upload-pack"));
    case "ls-remote":
      // `--exec` is ls-remote's and fetch-pack's old name for `--upload-pack`.
      return sh([...gitOptionValues(rest, "u", "--upload-pack"), ...gitOptionValues(rest, undefined, "--exec")]);
    case "fetch-pack":
      return sh([...gitOptionValues(rest, undefined, "--upload-pack"), ...gitOptionValues(rest, undefined, "--exec")]);
    case "archive":
      return sh(gitOptionValues(rest, undefined, "--exec"));
    case "for-each-repo": {
      let i = 0;
      while ((rest[i] ?? "").startsWith("-") && rest[i] !== "--")
        i += isLongOption("--config", rest[i] ?? "") && !(rest[i] ?? "").includes("=") ? 2 : 1;
      const cmd = rest.slice(rest[i] === "--" ? i + 1 : i);
      return cmd.length === 0 ? [] : [["git", ...cmd]];
    }
    default:
      return [];
  }
}

/** The command and every command it may run, and whether all of them were looked at. */
export function unwrapCommand(argv: string[], deep = true): { argvs: string[][]; complete: boolean } {
  const out: string[][] = [];
  const seen = new Set<string>();
  const queue = [argv];
  const budget: Budget = { words: MAX_WORDS, complete: true };
  for (let a = queue.shift(); a !== undefined && budget.complete; a = queue.shift()) {
    const key = a.join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    queue.push(...inner(a, deep, budget));
  }
  return { argvs: out, complete: budget.complete };
}

/** The command and every command it wraps (`sudo env X=1 git push` → `git push`; `find . -exec rm {} ;` → `rm {}`). */
export function strippedArgvs(argv: string[]): string[][] {
  return unwrapCommand(argv).argvs;
}

/** The command an allow rule is matched against last: every safe wrapper and safe assignment stripped. */
export const allowRuleArgv = (argv: string[]): string[] => unwrapCommand(argv, false).argvs.at(-1) ?? argv;

/** The text a rule is tried against: the argv re-joined with single spaces, then once per wrapper stripped off the front; deny and ask rules also see a path-named program by its name (`/bin/rm` → `rm`). */
export function shellVariants(argv: string[], deep: boolean): string[] {
  const out = new Set<string>();
  for (const v of unwrapCommand(argv, deep).argvs) {
    out.add(v.join(" "));
    if (deep) out.add([commandName(v[0]), ...v.slice(1)].join(" "));
  }
  return [...out];
}

const escapeRegExp = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** `:*` becomes ` *`; a trailing ` *` also matches the bare command. */
export function normalizeShellPattern(pattern: string): string {
  return pattern.trim().replaceAll(":*", " *");
}

export function shellPattern(pattern: string, ignoreCase = false): RegExp {
  const trailing = pattern.endsWith(" *");
  const body = trailing ? pattern.slice(0, -2) : pattern;
  return new RegExp(
    `^${body.split("*").map(escapeRegExp).join(".*")}${trailing ? "(?: .*)?" : ""}$`,
    ignoreCase ? "is" : "s",
  );
}

const EXEC_WRAPPERS = new Set(["watch", "setsid", "ionice", "flock"]);
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls|files0-from)$/;
const DAEMON_FLAGS = /^(-H|-r$|--host|--context|--url|--connection|--identity|--remote)/;
/** Whether the program reads `word` as the long option `name`: the full spelling, an abbreviation (a prefix past the bare `--`; git's parse-options and GNU wget take unique prefixes, and a spelling neither accepts is a command that doesn't run, so over-matching only adds asks and denies), optionally with `=value`. Git's own global options (`--git-dir`) are matched by git.c exactly and don't abbreviate. */
export function isLongOption(name: string, word: string): boolean {
  const head = word.split("=", 1)[0] ?? "";
  return head.length > 2 && name.startsWith(head);
}

const FORCE_FLAGS = /^(--force|--no-verify|--amend)/;
const FORCE_ABBREVIATIONS = ["--force", "--no-verify", "--amend"];

/** Commands only an exact-match rule may approve (permissions §3.2 "Never auto-approvable by prefix rules"). */
export function needsExactRule(argv: string[]): boolean {
  const [name = "", ...rest] = argv;
  if (EXEC_WRAPPERS.has(name)) return true;
  if (name === "find") return rest.some((a) => FIND_ACTIONS.test(a));
  if (name === "docker" || name === "podman") return rest.some((a) => DAEMON_FLAGS.test(a));
  if (name === "git" || name === "gh")
    return rest.some(
      (a) =>
        FORCE_FLAGS.test(a) ||
        FORCE_ABBREVIATIONS.some((n) => isLongOption(n, a)) ||
        (/^-[a-zA-Z]*f/.test(a) && rest.includes("push")) ||
        (/^\+/.test(a) && rest.includes("push")),
    );
  return false;
}

const CMDLET_ALIASES: Record<string, string> = {
  ls: "Get-ChildItem",
  dir: "Get-ChildItem",
  gci: "Get-ChildItem",
  cat: "Get-Content",
  gc: "Get-Content",
  type: "Get-Content",
  pwd: "Get-Location",
  gl: "Get-Location",
  sls: "Select-String",
  gi: "Get-Item",
  measure: "Measure-Object",
  cd: "Set-Location",
  chdir: "Set-Location",
  sl: "Set-Location",
  pushd: "Push-Location",
  popd: "Pop-Location",
  rm: "Remove-Item",
  del: "Remove-Item",
  ri: "Remove-Item",
  rmdir: "Remove-Item",
  rd: "Remove-Item",
  erase: "Remove-Item",
  cp: "Copy-Item",
  copy: "Copy-Item",
  cpi: "Copy-Item",
  mv: "Move-Item",
  move: "Move-Item",
  mi: "Move-Item",
  curl: "Invoke-WebRequest",
  wget: "Invoke-WebRequest",
  iwr: "Invoke-WebRequest",
  iex: "Invoke-Expression",
  echo: "Write-Output",
  sc: "Set-Content",
  ac: "Add-Content",
  ni: "New-Item",
  si: "Set-Item",
  ren: "Rename-Item",
  rni: "Rename-Item",
  rv: "Remove-Variable",
  saps: "Start-Process",
  start: "Start-Process",
  irm: "Invoke-RestMethod",
  icm: "Invoke-Command",
  kill: "Stop-Process",
  spps: "Stop-Process",
  ii: "Invoke-Item",
  tee: "Tee-Object",
  sp: "Set-ItemProperty",
  rp: "Remove-ItemProperty",
  clc: "Clear-Content",
  ipmo: "Import-Module",
  sv: "Set-Variable",
  set: "Set-Variable",
  sajb: "Start-Job",
};

/** The cmdlet an alias stands for (`rm` → `Remove-Item`); other names come back unchanged. */
export const canonicalCmdlet = (name: string): string => CMDLET_ALIASES[name.toLowerCase()] ?? name;
