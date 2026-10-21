import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function run(testSource: string): Promise<{ code: number; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dovet-testrun-"));
  dirs.push(dir);
  await symlink(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "junction");
  const file = join(dir, "fixture.test.ts");
  await writeFile(file, testSource);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "test-run.ts"), file], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { code, out: out + err };
}

const body = (cleanup: string): string => `
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
    const { code, out } = await run(body(""));
    expect(code).not.toBe(0);
    expect(out).toMatch(/left 1 temp director(y|ies) behind[\s\S]*dovet-tool-/);
  }, 30_000);

  test("a run that removes what it made passes", async () => {
    const { code, out } = await run(body("await rm(dir, { recursive: true, force: true });"));
    expect(out).not.toContain("left");
    expect(code).toBe(0);
  }, 30_000);
});
