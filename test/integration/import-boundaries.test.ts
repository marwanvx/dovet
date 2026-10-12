// The import-boundary check (`bun run lint:deps`, part of `bun run check`) run against small module trees in a temp
// directory, with the repository's real `.dependency-cruiser.cjs`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CONFIG = join(ROOT, ".dependency-cruiser.cjs");
const DEPCRUISE = join(ROOT, "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function tree(files: Record<string, string>): void {
  dir = mkdtempSync(join(tmpdir(), "dovet-boundaries-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowImportingTsExtensions: true } }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function cruise(): { code: number; out: string } {
  const r = Bun.spawnSync([process.execPath, "--bun", DEPCRUISE, "src", "--config", CONFIG], { cwd: dir });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("import boundaries", () => {
  // spec: AC-ARCH-04
  test("a forbidden edge (tools importing agent) fails the check and names the edge", () => {
    tree({
      "src/agent/index.ts": "export const agent = 1;\n",
      "src/tools/index.ts": 'import { agent } from "../agent/index.ts";\nexport const tools = agent;\n',
    });
    const r = cruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no-tools-to-agent");
  });

  // spec: AC-ARCH-04
  test("an allowed edge (agent importing tools) passes", () => {
    tree({
      "src/tools/index.ts": "export const tools = 1;\n",
      "src/agent/index.ts": 'import { tools } from "../tools/index.ts";\nexport const agent = tools;\n',
    });
    const r = cruise();
    expect(r.out).toContain("no dependency violations found");
    expect(r.code).toBe(0);
  });

  test("a module importing its own internal files passes", () => {
    tree({
      "src/tools/read.ts": "export const read = 1;\n",
      "src/tools/index.ts": 'export { read } from "./read.ts";\n',
    });
    const r = cruise();
    expect(r.out).toContain("no dependency violations found");
    expect(r.code).toBe(0);
  });

  test("importing another module's internal file instead of its index.ts fails", () => {
    tree({
      "src/tools/read.ts": "export const read = 1;\n",
      "src/tools/index.ts": 'export { read } from "./read.ts";\n',
      "src/agent/index.ts": 'import { read } from "../tools/read.ts";\nexport const agent = read;\n',
    });
    const r = cruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("only-via-index");
  });

  test("a circular import inside a module fails", () => {
    tree({
      "src/tools/a.ts": 'import { b } from "./b.ts";\nexport const a = () => b;\n',
      "src/tools/b.ts": 'import { a } from "./a.ts";\nexport const b = () => a;\n',
      "src/tools/index.ts": 'export { a } from "./a.ts";\n',
    });
    const r = cruise();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no-circular");
  });
});
