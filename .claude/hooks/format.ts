// PostToolUse(Edit|Write|Bash): format and lint-fix what an edit changed with Biome, so `bun run check` doesn't fail on style.
// Edit and Write name the file. A Bash command that writes files (python, sed -i, a heredoc) doesn't, and that is how most
// edits happen, so the files come from git.
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { changedCode } from "./stop-gate.ts";

/** Whether a Bash command may write files. Too broad only costs a Biome run that changes nothing. */
export function writesFiles(command: string): boolean {
  return /<<|\bsed\s+(-\S*i|--in-place)|\btee\b|\bperl\s+-\S*i|\bgit\s+apply\b|\bpython3?\b|\bbun\s+-e\b|(?<![0-9&])>>?(?!\s*\/dev\/null)\s*[^&\s]/.test(
    command,
  );
}

if (import.meta.main) {
  const input = (await Bun.stdin.json()) as {
    tool_name?: string;
    tool_input?: { file_path?: string; command?: string };
    cwd?: string;
  };
  const root = input.cwd ?? process.cwd();
  const formattable = (p: string): boolean => /\.(ts|tsx|js|json|jsonc)$/.test(p);
  let targets: string[] = [];
  if (input.tool_name === "Bash") {
    if (!writesFiles(input.tool_input?.command ?? "")) process.exit(0);
    const status = Bun.spawn(["git", "status", "--porcelain"], { cwd: root, stdout: "pipe", stderr: "ignore" });
    targets = changedCode(await new Response(status.stdout).text()).filter((p) => formattable(p) && existsSync(`${root}/${p}`));
  } else {
    const file = input.tool_input?.file_path;
    if (file !== undefined && formattable(file) && !relative(root, file).startsWith("..")) targets = [relative(root, file)];
  }
  if (targets.length === 0) process.exit(0);
  const proc = Bun.spawn(["bunx", "biome", "check", "--write", "--no-errors-on-unmatched", ...targets], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Exit 2 shows Biome's remaining (unfixable) findings to the model; the edit itself already happened.
  if (code !== 0) {
    console.error(`${out}${err}`.trim());
    process.exit(2);
  }
}
