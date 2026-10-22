// `bun run test`: the whole suite in a private temp directory, failing if it leaves a test workspace behind.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const WORKSPACE_PREFIX = "dovet-tool-";

export async function leftovers(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith(WORKSPACE_PREFIX)).sort();
}

/** One windows-latest run stalled for about 20 s, so tests that take 0.1 s elsewhere took over 5 s each (F24). A flag, not a
 * preload: a preload's `setDefaultTimeout` covers only the first test file of a run. A file's own default still wins. */
export function testCommand(platform: NodeJS.Platform, args: string[]): string[] {
  return ["bun", "test", "--check", "--timeout", platform === "win32" ? "30000" : "5000", ...args];
}

export async function runTests(args: string[]): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), "dovet-testrun-"));
  try {
    const proc = Bun.spawn(testCommand(process.platform, args), {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root },
    });
    const code = await proc.exited;
    const left = await leftovers(root);
    if (left.length === 0) return code;
    console.error(
      `\nThe test run left ${left.length} temp director${left.length === 1 ? "y" : "ies"} behind (a test that makes a workspace must remove it, and wait for anything still writing into it):\n  ${left.join("\n  ")}`,
    );
    return code === 0 ? 1 : code;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await runTests(process.argv.slice(2)));
