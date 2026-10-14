// Shell rule text: a stopgap command splitter and wrapper stripping (permissions §3.2) until M1-22 supplies parsed commands.
export type Redirect = { op: string; target: string };
export type Subcommand = {
  argv: string[];
  redirects?: Redirect[];
  /** Set by the analyzer (permissions §4.6): the command only reads, so it needs no allow rule of its own. */
  readOnly?: boolean;
};

const REDIRECT = /^(?:&>>?|>>|>\||>&?|<&?)/;
const SEPARATORS = ["&&", "||", "|&", ";", "|", "&", "\n"];

/** Splits a command into simple commands, or undefined when it holds anything this reader can't take apart exactly. */
export function splitCommand(command: string): Subcommand[] | undefined {
  const out: Subcommand[] = [];
  let cur: Required<Omit<Subcommand, "readOnly">> = { argv: [], redirects: [] };
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
  ["xargs", { safe: true, valued: ["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a"], positional: 0 }],
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

/** The command with one wrapper or leading assignment removed. `deep` (deny and ask rules) also strips exec wrappers and any assignment. */
function stripOne(argv: string[], deep: boolean): string[] | undefined {
  let i = 0;
  while (i < argv.length) {
    const name = ASSIGNMENT.exec(argv[i] ?? "")?.[1];
    if (name === undefined || !(deep || isSafeEnv(name))) break;
    i++;
  }
  if (i > 0) return i < argv.length ? argv.slice(i) : undefined;
  const w = WRAPPERS.get(argv[0] ?? "");
  if (w === undefined || !(w.safe || deep)) return undefined;
  let j = 1;
  for (; j < argv.length; j++) {
    const tok = argv[j] ?? "";
    if (tok === "--") {
      j++;
      break;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      if (w.noFlags || (argv[0] === "xargs" && !deep)) return undefined;
      if (w.valued.includes(tok)) j++;
    } else if (!(argv[0] === "env" && ASSIGNMENT.test(tok))) break;
  }
  j += w.positional;
  return j < argv.length ? argv.slice(j) : undefined;
}

/** The text a rule is tried against: the argv re-joined with single spaces, then once per wrapper stripped off the front. */
export function shellVariants(argv: string[], deep: boolean): string[] {
  const out = [argv.join(" ")];
  for (let cur = stripOne(argv, deep); cur !== undefined; cur = stripOne(cur, deep)) out.push(cur.join(" "));
  return out;
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
};

/** The cmdlet an alias stands for (`rm` → `Remove-Item`); other names come back unchanged. */
export const canonicalCmdlet = (name: string): string => CMDLET_ALIASES[name.toLowerCase()] ?? name;
