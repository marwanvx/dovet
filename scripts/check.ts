// `bun run check`: every gate in order. Unlike an `&&` chain, a failing step doesn't hide the ones after it.

export type Step = { name: string; cmd: string[] };
export type Result = { name: string; code: number; seconds: number };

export const STEPS: Step[] = [
  { name: "types", cmd: ["bun", "check", "-b"] },
  { name: "lint", cmd: ["bun", "run", "lint"] },
  { name: "lint:deps", cmd: ["bun", "run", "lint:deps"] },
  { name: "test", cmd: ["bun", "run", "test"] },
  { name: "spec:coverage", cmd: ["bun", "run", "spec:coverage"] },
  { name: "docs:check", cmd: ["bun", "run", "docs:check"] },
  { name: "wiring", cmd: ["bun", "run", "wiring"] },
];

export async function runSteps(steps: readonly Step[], run: (cmd: string[]) => Promise<number>): Promise<Result[]> {
  const results: Result[] = [];
  for (const step of steps) {
    const started = performance.now();
    const code = await run(step.cmd);
    results.push({ name: step.name, code, seconds: Math.round((performance.now() - started) / 1000) });
  }
  return results;
}

export function summary(results: readonly Result[]): string {
  const lines = results.map((r) => `${r.code === 0 ? "PASS" : "FAIL"}  ${r.name} (${r.seconds}s)`);
  const failed = results.filter((r) => r.code !== 0).map((r) => r.name);
  lines.push(
    failed.length === 0
      ? `all ${results.length} steps passed`
      : `${failed.length} of ${results.length} steps failed: ${failed.join(", ")}`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const results = await runSteps(STEPS, async (cmd) => {
    console.log(`\n== ${cmd.join(" ")}`);
    return await Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exited;
  });
  console.log(`\n${summary(results)}`);
  process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
}
