// Shell analysis agrees with bash (testing "Shell analysis agrees with bash"): generated texts run under real bash with
// every command a recording stub; whatever bash ran must be in the analysis, or the analysis must be unparsed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlatformCore, type Os } from "../../src/platform/index.ts";
import { analyzeShell } from "../../src/policy/shell-parse/analyze.ts";
import { expandGlob, isDirectory } from "../../src/policy/shell-parse/glob.ts";
import { loadShellParsers, type ShellParsers } from "../../src/policy/shell-parse/load.ts";
import { type TempProject, tempProject } from "../helpers/index.ts";

const CASES = Number(process.env.DOVET_DIFF_CASES ?? 2000);
const SEED = Number(process.env.DOVET_DIFF_SEED ?? 20261028);
const NAMES = ["git", "cat", "rm", "printf", "echo"];

/** Shell texts from a seed (mulberry32), so a failing seed reproduces. */
function generator(seed: number): () => string {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const many = (n: number, f: () => string, sep: string): string =>
    Array.from({ length: 1 + Math.floor(rand() * n) }, f).join(sep);
  const name = (): string => {
    const n = pick(NAMES);
    const cut = 1 + Math.floor(rand() * (n.length - 1));
    return pick([n, n, `${n.slice(0, cut)}''\\${n.slice(cut)}`, `${n.slice(0, cut)}""${n.slice(cut)}`, `\\${n}`]);
  };
  const simple = (): string => `${name()} ${pick(["push", "a", ".env", "-f"])}`;
  const LEAVES = [
    "push",
    "a",
    ".env",
    "''",
    '""',
    "'a b'",
    '"q r"',
    "\\s",
    "\\ ",
    "\\\\",
    "\\'",
    "$(( 1 ))",
    "$[ 1 ]",
    "'}'",
    '"}"',
    "\\}",
  ];
  const piece = (d: number): string => {
    const r = rand();
    if (r < 0.5) return pick(["push", "a", ".env", "-f"]);
    if (d >= 2 || r < 0.8) return pick(LEAVES);
    const quote = (): string => pick(["", "'", '"']);
    return pick([
      () => `$(${cmd(d + 1)})`,
      () => `\`${simple()}\``,
      () => `<(${cmd(d + 1)})`,
      () => `>(${cmd(d + 1)})`,
      () => `\${x${pick([":-", ":=", ":+", "-"])}${quote()}${piece(d + 1)}${quote()}}`,
      () => `"${piece(d + 1)}"`,
      () => `$(( 1 #${piece(d + 1)}\n))`,
    ])();
  };
  const word = (d: number): string => many(2, () => piece(d), "");
  const cmd = (d: number): string =>
    [name(), ...Array.from({ length: Math.floor(rand() * 3) }, () => word(d))].join(" ");
  const statement = (): string => {
    const prefix = pick(["", "", `a=${word(1)} `, `a[${word(1)}]=1 `]);
    const body = pick([
      () => many(4, () => cmd(0), " | "),
      () => `cat <<${pick(["", "-"])}${pick(["E", "'E'"])}\n${pick(["", " ", "\t"])}${word(1)}\n${pick(["", "\t"])}E`,
      () => `declare a[${word(1)}]=1`,
    ])();
    return `${prefix}${body}${pick(["", "", ` # ${word(1)}`])}`;
  };
  return () => many(3, statement, pick([" && ", " || ", "; ", "\n"]));
}

// ANSI-C quoting that survives any byte: everything but letters, digits and spaces as \xHH.
const ansiC = (text: string): string =>
  `$'${[...text].map((c) => (/[A-Za-z0-9 ]/.test(c) ? c : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)).join("")}'`;

const os: Os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
let parsers: ShellParsers;
let project: TempProject;
beforeAll(async () => {
  parsers = await loadShellParsers();
  project = await tempProject();
});
afterAll(() => project.dispose());

/** Runs every text in one bash, each command a stub that appends its argv to the text's own record file. */
async function runUnderBash(bash: string, texts: string[]): Promise<string[][][]> {
  const dir = join(project.root, "records");
  await mkdir(dir);
  const posix = (p: string): string => p.replaceAll("\\", "/");
  const lines = [
    "__rec() { local IFS=$'\\037'; builtin printf '%s\\036' \"$*\" >> \"$__out\"; }",
    ...NAMES.map((n) => `${n}() { __rec ${n} "$@"; }`),
    'command_not_found_handle() { __rec "$@"; }',
    ...texts.map((t, i) => `__out=${ansiC(posix(join(dir, String(i))))}; unset -v x a; eval ${ansiC(t)}`),
    "wait; sleep 0.2",
  ];
  const script = join(project.root, "cases.sh");
  await writeFile(script, `${lines.join("\n")}\n`);
  const child = Bun.spawn([bash, posix(script)], {
    cwd: project.root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return Promise.all(
    texts.map(async (_, i) => {
      const raw = await readFile(join(dir, String(i)), "utf8").catch(() => "");
      return raw
        .split("\x1e")
        .slice(0, -1)
        .map((r) => r.split("\x1f"));
    }),
  );
}

// A word the analysis couldn't read as a literal keeps its text: it stands for any run of words bash ran, even none
// (an empty unquoted substitution vanishes).
const computed = (w: string): boolean => /[$`]|[<>]\(/.test(w);
function matches(analyzed: string[], ran: string[], p = 0, r = 0): boolean {
  const w = analyzed[p];
  if (w === undefined) return r === ran.length;
  if (!computed(w)) return ran[r] === w && matches(analyzed, ran, p + 1, r + 1);
  for (let k = r; k <= ran.length; k++) if (matches(analyzed, ran, p + 1, k)) return true;
  return false;
}

// spec: AC-PERM-20
test(`every command bash runs is in the analysis, or it is unparsed (${CASES} cases, seed ${SEED})`, async () => {
  const core = createPlatformCore({
    os,
    arch: "x64",
    execPath: process.execPath,
    env: process.env,
    projectRoot: project.root,
    kill: (pid, signal) => process.kill(pid, signal),
  });
  const shell = await core.resolveShell();
  expect(shell?.kind === "bash" || shell?.kind === "git-bash").toBe(true);
  if (shell === undefined) return;
  const next = generator(SEED);
  const texts = Array.from({ length: CASES }, next);
  const ran = await runUnderBash(shell.path, texts);
  const missed: string[] = [];
  let parsed = 0;
  for (const [i, text] of texts.entries()) {
    const a = analyzeShell(parsers, "bash", text, {
      cwd: project.root,
      workingDirs: [project.root],
      glob: expandGlob,
      isDirectory,
      budgetMs: 2000,
    });
    if (a.commands === undefined) continue;
    parsed++;
    const argvs = a.commands.map((c) =>
      c.argv.filter((w, k) => k > 0 || !/^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?=/s.test(w)),
    );
    for (const argv of ran[i] ?? []) {
      const found = argvs.some((b) => matches(b, argv));
      if (!found) missed.push(`${JSON.stringify(text)} ran ${JSON.stringify(argv)}`);
    }
  }
  expect(missed).toEqual([]);
  // The comparison means something only if bash ran the stubs and most texts were analyzed, not refused.
  expect(ran.filter((r) => r.length > 0).length).toBeGreaterThan(CASES / 2);
  expect(parsed).toBeGreaterThan(CASES / 5);
}, 300_000);
