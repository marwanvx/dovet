// The repository's own lint rules (biome.json plugins in scripts/lint/; architecture "State ownership", interfaces §9).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const ROOT = join(import.meta.dir, "..", "..");
const BIOME = join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome");

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const BiomeConfig = z.looseObject({
  plugins: z.array(z.string()).optional(),
  overrides: z.array(z.looseObject({ plugins: z.array(z.string()).optional() })).optional(),
  vcs: z.unknown().optional(),
});

function absolute(paths: string[] | undefined): string[] | undefined {
  return paths?.map((p) => (isAbsolute(p) ? p : resolve(ROOT, p)));
}

/** The repository's biome.json with plugin paths made absolute, so it works from a temp directory. */
function lint(files: Record<string, string>): { code: number; out: string } {
  dir = mkdtempSync(join(tmpdir(), "dovet-lint-"));
  const config = BiomeConfig.parse(JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8")));
  delete config.vcs;
  if (config.plugins) config.plugins = absolute(config.plugins) ?? [];
  for (const o of config.overrides ?? []) if (o.plugins) o.plugins = absolute(o.plugins) ?? [];
  writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const r = Bun.spawnSync([process.execPath, "--bun", BIOME, "lint", "."], { cwd: dir });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("module-level state", () => {
  test.each([
    ["let", "let counter = 0;\nexport const next = () => counter++;\n"],
    ["exported let", "export let cache = new Map<string, string>();\n"],
    ["var", "var legacy = 1;\nexport const read = () => legacy;\n"],
    ["exported var", "export var legacy = 1;\n"],
  ])("a top-level %s in src/ fails the lint", (_name, text) => {
    const r = lint({ "src/agent/state.ts": text });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("State ownership");
  });

  test("const, and let inside functions, blocks, loops and classes, pass", () => {
    const r = lint({
      "src/agent/ok.ts": [
        "export const limit = 10;",
        "export function f(): number {",
        "  let n = 0;",
        "  for (let i = 0; i < limit; i++) n += i;",
        "  if (n > 1) { let m = n; n = m; }",
        "  return n;",
        "}",
        "export const g = (): number => { let k = 1; k += 1; return k; };",
        "export class C { static { let s = 1; void s; } method(): number { let t = 1; t += 1; return t; } }",
        "",
      ].join("\n"),
    });
    expect(r.out).not.toContain("State ownership");
    expect(r.code).toBe(0);
  });

  test("test files and scripts may keep module-level state", () => {
    const text = "let shared = 0;\nexport const bump = (): number => ++shared;\n";
    const r = lint({ "src/agent/state.test.ts": text, "scripts/tool.ts": text, "test/helpers/shared.ts": text });
    expect(r.out).not.toContain("State ownership");
  });
});

describe("process environment and directory", () => {
  test.each([
    ["a property write", 'process.env.TOKEN = "x";\n'],
    ["a bracket write", 'const k = "A";\nprocess.env[k] = "x";\nexport { k };\n'],
    ["a logical assignment", 'process.env.A ||= "x";\n'],
    ["a delete", "delete process.env.TOKEN;\n"],
    ["Object.assign", 'Object.assign(process.env, { A: "1" });\n'],
    ["replacing the object", "process.env = {};\n"],
    ["a write inside a function", 'export function f(): void { process.env.A = "1"; }\n'],
    ["process.chdir", 'process.chdir("/tmp");\n'],
    ["Bun.env", 'Bun.env.TOKEN = "x";\n'],
    ["globalThis.process", 'globalThis.process.env.A = "1";\n'],
    ["a quoted env key", 'process["env"].A = "1";\n'],
    ["Reflect.set", 'Reflect.set(process.env, "A", "1");\n'],
    ["Reflect.deleteProperty", 'Reflect.deleteProperty(process.env, "A");\n'],
    ["Object.defineProperty", 'Object.defineProperty(process.env, "A", { value: "1" });\n'],
    ["Object.assign on Bun.env", 'Object.assign(Bun.env, { A: "1" });\n'],
    ["importing env from node:process", 'import { env } from "node:process";\nexport const e = env;\n'],
    ["importing chdir from process", 'import { chdir } from "process";\nchdir("/tmp");\n'],
  ])("%s in src/ fails the lint", (_name, text) => {
    const r = lint({ "src/cli/main.ts": text });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("State ownership");
  });

  test("reading the environment or writing to a child environment passes", () => {
    const r = lint({
      "src/cli/main.ts": [
        "export const home = process.env.HOME;",
        "export const copy = { ...process.env };",
        'export const child: Record<string, string> = { A: "1" };',
        'child.B = "2";',
        "export const wrapper = { env: child };",
        'wrapper.env.C = "3";',
        "",
      ].join("\n"),
    });
    expect(r.out).not.toContain("State ownership");
    expect(r.code).toBe(0);
  });
});
