import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testCommand } from "./test-run.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function run(sources: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dovet-testrun-"));
  dirs.push(dir);
  const files = await Promise.all(
    sources.map(async (source, i) => {
      const file = join(dir, `fixture${i}.test.ts`);
      await writeFile(file, source);
      return file;
    }),
  );
  const proc = Bun.spawn(["bun", join(import.meta.dir, "test-run.ts"), ...files], {
    cwd: cwd ?? dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { code, out: out + err };
}

const body = (cleanup: string): string => `// @ts-nocheck
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("makes a workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dovet-tool-"));
  ${cleanup}
  expect(dir.startsWith("dovet-tool-")).toBe(false);
});
`;

describe("bun run test", () => {
  test("a run that leaves a dovet-tool- directory behind fails and names it", async () => {
    const { code, out } = await run([body("")]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/left 1 temp director(y|ies) behind[\s\S]*dovet-tool-/);
  }, 30_000);

  test("a run that removes what it made passes", async () => {
    const { code, out } = await run([body("await rm(dir, { recursive: true, force: true });")]);
    expect(out).not.toContain("left");
    expect(code).toBe(0);
  }, 30_000);

  test("every test file's workspace() directories are removed, not only the first file's", async () => {
    const context = JSON.stringify(join(import.meta.dir, "..", "src", "tools", "test-context.ts"));
    const file = `// @ts-nocheck
import { test } from "bun:test";
import { workspace } from ${context};
test("makes a workspace", async () => { await workspace(); });
`;
    const { code, out } = await run([file, file], join(import.meta.dir, ".."));
    expect(out).not.toContain("left");
    expect(code).toBe(0);
  }, 30_000);
});

describe("the default test timeout", () => {
  test("Windows gets six times Bun's 5 s default, other systems keep it", () => {
    expect(testCommand("win32", ["a.test.ts"])).toEqual(["bun", "test", "--check", "--timeout", "30000", "a.test.ts"]);
    expect(testCommand("linux", [])).toEqual(["bun", "test", "--check", "--timeout", "5000"]);
    expect(testCommand("darwin", [])).toEqual(["bun", "test", "--check", "--timeout", "5000"]);
  });

  // A preload's setDefaultTimeout covered only the first file of a run, so F24's 30 s never reached the rest.
  test("the Windows command gives a 6 s test in the second file of a run the 30 s limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-testrun-"));
    dirs.push(dir);
    const files = await Promise.all(
      ["first", "second"].map(async (name) => {
        const file = join(dir, `${name}.test.ts`);
        await writeFile(
          file,
          `// @ts-nocheck\nimport { test } from "bun:test";\ntest("${name}", async () => { await Bun.sleep(6000); });\n`,
        );
        return file;
      }),
    );
    const proc = Bun.spawn(testCommand("win32", files), { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(out + err).toContain(" 2 pass");
    expect(code).toBe(0);
  }, 60_000);
});
