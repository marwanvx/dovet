// Stop: while changed code has type or lint errors, send Claude back to fix them instead of finishing (Claude Code docs: a Stop hook as a deterministic gate).
export type Check = { name: string; code: number; output: string };

export function changedCode(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((p) => /\.(ts|tsx|json|jsonc)$/.test(p));
}

export function blockReason(checks: readonly Check[]): string | undefined {
  const failed = checks.filter((c) => c.code !== 0);
  if (failed.length === 0) return undefined;
  const details = failed.map((c) => `## ${c.name}\n${c.output.trim().split("\n").slice(0, 40).join("\n")}`);
  return `Don't finish yet: ${failed.map((c) => c.name).join(" and ")} fail on your changes. Fix them first.\n\n${details.join("\n\n")}`;
}

async function run(argv: string[], cwd: string): Promise<Check> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { name: argv.slice(1).join(" "), code, output: `${out}${err}` };
}

if (import.meta.main) {
  const input = (await Bun.stdin.json()) as { cwd?: string };
  const cwd = input.cwd ?? process.cwd();
  const status = await run(["git", "status", "--porcelain"], cwd);
  if (changedCode(status.output).length > 0) {
    const reason = blockReason([
      await run(["bunx", "tsc", "-b", "--pretty", "false"], cwd),
      await run(["bunx", "biome", "check", "."], cwd),
    ]);
    if (reason !== undefined) console.log(JSON.stringify({ decision: "block", reason }));
  }
}
