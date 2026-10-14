// SPIKE-15 (docs/plan/open-questions.md): the tree-sitter runtime and the Bash and PowerShell grammars are embedded
// in the compiled binary and parse commands there (permissions §4.0, ADR-9). The probe is built with Dovet's real
// compile options and run from a temp directory with no node_modules, so only the embedded .wasm files can load.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDovet } from "../../../scripts/build.ts";
import { isErrno } from "../../../src/platform/index.ts";

const EXE = process.platform === "win32" ? ".exe" : "";

// Each sample with a node type its parse tree must contain, so a tree that "parses" into nothing useful fails.
const BASH: [string, string][] = [
  ["ls -la src", "command"],
  ["git status && git diff --stat", "list"],
  ["cat README.md | grep -n 'Dovet' | head -5", "pipeline"],
  ['echo "hello $USER" > out.txt', "file_redirect"],
  ["cd src; rg --files", "command"],
  ["FOO=bar python3 app.py", "variable_assignment"],
  ['echo "$(git rev-parse HEAD)"', "command_substitution"],
  ['for f in *.ts; do wc -l "$f"; done', "for_statement"],
  ["cat <<'EOF'\nplain text\nEOF", "heredoc_body"],
  ["diff <(sort a.txt) <(sort b.txt)", "process_substitution"],
];
const POWERSHELL: [string, string][] = [
  ["Get-ChildItem -Path src -Recurse", "command"],
  ["Get-Content README.md | Select-String Dovet", "pipeline"],
  ["$files = Get-ChildItem *.ts", "assignment_expression"],
  ["git status; git log --oneline -5", "command"],
  ['Write-Output "hello $env:USERNAME"', "expandable_string_literal"],
  ["Remove-Item -Recurse -Force .\\dist", "command_parameter"],
  ["foreach ($f in Get-ChildItem) { $f.Name }", "foreach_statement"],
  ["if (Test-Path x.txt) { Get-Content x.txt }", "if_statement"],
  ["& 'C:\\Program Files\\Git\\bin\\git.exe' status", "command_invokation_operator"],
  ["Get-Process | Where-Object { $_.CPU -gt 10 } | Sort-Object CPU", "script_block"],
];
// Malformed input must be reported as an error, never silently accepted (permissions §4.0 "fails closed").
const BASH_BROKEN = ["echo 'unterminated", "if true; then"];
const POWERSHELL_BROKEN = ["Get-Item (", "foreach ($x in) {"];

type Parsed = { root: string; hasError: boolean; tree: string };
type ProbeOut = {
  abi: { runtime: number; minCompatible: number; bash: number; powershell: number };
  files: { runtime: string; bash: string; powershell: string };
  bash: Parsed[];
  powershell: Parsed[];
};

// The embedded filesystem of a compiled Bun binary: `/$bunfs/…` on Linux and macOS, `B:\~BUN\…` on Windows.
const EMBEDDED = /^(\/\$bunfs\/|[A-Z]:[\\/]~BUN[\\/])/;

let dir = "";
let out: ProbeOut;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dovet-shell-parse-"));
  const probe = join(dir, `probe${EXE}`);
  await compileDovet({ entry: join(import.meta.dir, "parse-probe.ts"), outfile: probe });
  const input = JSON.stringify({
    bash: [...BASH.map(([c]) => c), ...BASH_BROKEN],
    powershell: [...POWERSHELL.map(([c]) => c), ...POWERSHELL_BROKEN],
  });
  const r = Bun.spawnSync([probe], { cwd: dir, stdin: Buffer.from(input) });
  if (r.exitCode !== 0) throw new Error(`probe failed (${r.exitCode}): ${r.stderr.toString()}`);
  out = JSON.parse(r.stdout.toString()) as ProbeOut;
}, 120_000);

afterAll(() => {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    // Windows (often its virus scanner) can hold a just-run executable for longer than the retries; a leftover temp dir is harmless.
    if (process.platform !== "win32" || !isErrno(e, "EBUSY", "EPERM")) throw e;
    console.warn(`left ${dir} behind: ${String(e)}`);
  }
});

describe("compiled binary parses shell commands with the embedded grammars", () => {
  test("the runtime and both grammars load from inside the binary, not from disk", () => {
    expect(out.files.runtime).toMatch(EMBEDDED);
    expect(out.files.bash).toMatch(EMBEDDED);
    expect(out.files.powershell).toMatch(EMBEDDED);
  });

  test("both grammars' ABI versions are within the runtime's supported range", () => {
    for (const lang of ["bash", "powershell"] as const) {
      expect(out.abi[lang]).toBeGreaterThanOrEqual(out.abi.minCompatible);
      expect(out.abi[lang]).toBeLessThanOrEqual(out.abi.runtime);
    }
  });

  test.each(BASH.map(([cmd, node], i) => [cmd, node, i] as const))("bash: %p", (_cmd, node, i) => {
    const p = out.bash[i];
    expect(p?.root).toBe("program");
    expect(p?.hasError).toBe(false);
    expect(p?.tree).toContain(`(${node}`);
  });

  test.each(POWERSHELL.map(([cmd, node], i) => [cmd, node, i] as const))("powershell: %p", (_cmd, node, i) => {
    const p = out.powershell[i];
    expect(p?.root).toBe("program");
    expect(p?.hasError).toBe(false);
    expect(p?.tree).toContain(`(${node}`);
  });

  test("malformed commands are reported as errors", () => {
    expect(out.bash.slice(BASH.length).map((p) => p.hasError)).toEqual(BASH_BROKEN.map(() => true));
    expect(out.powershell.slice(POWERSHELL.length).map((p) => p.hasError)).toEqual(POWERSHELL_BROKEN.map(() => true));
  });
});
