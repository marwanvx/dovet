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

export const XARGS_VALUED = new Set([
  "-n",
  "-I",
  "-P",
  "-L",
  "-d",
  "-E",
  "-s",
  "-a",
  "--max-args",
  "--replace",
  "--max-procs",
  "--max-lines",
  "--delimiter",
  "--eof",
  "--max-chars",
  "--arg-file",
  "--process-slot-var",
]);

type Wrapper = { safe: boolean; valued: string[]; positional: number; noFlags?: boolean };
const WRAPPERS = new Map<string, Wrapper>([
  ["timeout", { safe: true, valued: ["-k", "-s", "--kill-after", "--signal"], positional: 1 }],
  ["time", { safe: true, valued: ["-f", "-o", "--format", "--output"], positional: 0 }],
  ["nice", { safe: true, valued: ["-n", "--adjustment"], positional: 0 }],
  ["nohup", { safe: true, valued: [], positional: 0 }],
  ["stdbuf", { safe: true, valued: ["-i", "-o", "-e", "--input", "--output", "--error"], positional: 0 }],
  ["command", { safe: true, valued: [], positional: 0, noFlags: true }],
  ["builtin", { safe: true, valued: [], positional: 0, noFlags: true }],
  ["noglob", { safe: true, valued: [], positional: 0, noFlags: true }],
  ["xargs", { safe: true, valued: [...XARGS_VALUED], positional: 0 }],
  ["env", { safe: false, valued: ["-u", "-C", "-S", "--unset", "--chdir"], positional: 0 }],
  [
    "sudo",
    {
      safe: false,
      valued: [
        "-u",
        "-g",
        "-h",
        "-p",
        "-C",
        "-D",
        "-R",
        "-T",
        "-U",
        "--user",
        "--group",
        "--host",
        "--prompt",
        "--chdir",
      ],
      positional: 0,
    },
  ],
  ["doas", { safe: false, valued: ["-u", "-C"], positional: 0 }],
  ["watch", { safe: false, valued: ["-n", "--interval"], positional: 0 }],
  ["ionice", { safe: false, valued: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"], positional: 0 }],
  ["setsid", { safe: false, valued: [], positional: 0 }],
  ["flock", { safe: false, valued: ["-w", "-E", "--timeout", "--conflict-exit-code"], positional: 1 }],
]);
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

/** `-u`, `-iu` and `-uroot` → whether the flag's value is the next word. */
function takesNext(tok: string, valued: string[]): boolean {
  if (valued.includes(tok)) return true;
  if (tok.startsWith("--")) return false;
  for (let k = 1; k < tok.length; k++) if (valued.includes(`-${tok.charAt(k)}`)) return k === tok.length - 1;
  return false;
}

/** `env -S 'a b' c` → `env a b c`: env splits the string and goes on reading its own options from it. */
function splitString(argv: string[], j: number): string[] | undefined {
  const tok = argv[j] ?? "";
  let value: string | undefined;
  let next = j + 1;
  if (tok.startsWith("--split-string")) {
    if (tok.startsWith("--split-string=")) value = tok.slice(15);
    else if (tok === "--split-string") [value, next] = [argv[j + 1], j + 2];
  } else if (!tok.startsWith("--")) {
    const at = [...tok.slice(1)].findIndex((c) => c === "S" || c === "u" || c === "C") + 1;
    if (tok.charAt(at) === "S")
      [value, next] = at === tok.length - 1 ? [argv[j + 1], j + 2] : [tok.slice(at + 1), j + 1];
  }
  if (value === undefined) return undefined;
  const words = splitCommand(value)?.flatMap((s) => s.argv) ?? value.split(/\s+/).filter(Boolean);
  return [argv[0] ?? "env", ...words, ...argv.slice(next)];
}

const FIND_EXEC = /^-(exec|execdir|ok|okdir)$/;

/** Every command `find … -exec cmd … ;` runs (to `;`, `+` or the end). */
function findCommands(argv: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!FIND_EXEC.test(argv[i] ?? "")) continue;
    let end = i + 1;
    while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end++;
    if (end > i + 1) out.push(argv.slice(i + 1, end));
    i = end;
  }
  return out;
}

/**
 * The commands inside this one, one wrapper or leading assignment removed. `deep` (deny and ask rules, and every
 * built-in check) also strips exec wrappers and any assignment, knows a wrapper written as a path and looks into
 * `find -exec`; an allow rule only sees through a safe wrapper called by its bare name.
 */
function inner(argv: string[], deep: boolean): string[][] {
  let i = 0;
  while (i < argv.length) {
    const name = ASSIGNMENT.exec(argv[i] ?? "")?.[1];
    if (name === undefined || !(deep || isSafeEnv(name))) break;
    i++;
  }
  if (i > 0) return i < argv.length ? [argv.slice(i)] : [];
  const name = deep ? commandName(argv[0]) : (argv[0] ?? "");
  if (deep && name === "find") return findCommands(argv);
  const w = WRAPPERS.get(name);
  if (w === undefined || !(w.safe || deep)) return [];
  let j = 1;
  for (; j < argv.length; j++) {
    const tok = argv[j] ?? "";
    if (tok === "--") {
      j++;
      break;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      if (w.noFlags || (name === "xargs" && !deep)) return [];
      const split = name === "env" ? splitString(argv, j) : undefined;
      if (split !== undefined) return [split];
      if (takesNext(tok, w.valued)) j++;
    } else if (!(name === "env" && ASSIGNMENT.test(tok))) break;
  }
  j += w.positional;
  return j < argv.length ? [argv.slice(j)] : [];
}

function unwrapAll(argv: string[], deep: boolean): string[][] {
  const out: string[][] = [];
  const queue = [argv];
  for (let a = queue.shift(); a !== undefined; a = queue.shift()) {
    out.push(a);
    queue.push(...inner(a, deep));
  }
  return out;
}

/** The command and every command it wraps (`sudo env X=1 git push` → `git push`; `find . -exec rm {} ;` → `rm {}`). */
export function strippedArgvs(argv: string[]): string[][] {
  return unwrapAll(argv, true);
}

/** The text a rule is tried against: the argv re-joined with single spaces, then once per wrapper stripped off the front; deny and ask rules also see a path-named program by its name (`/bin/rm` → `rm`). */
export function shellVariants(argv: string[], deep: boolean): string[] {
  const out = new Set<string>();
  for (const v of unwrapAll(argv, deep)) {
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
const FORCE_FLAGS = /^(--force|--no-verify|--amend)/;

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
