// The compiled binary must not load a project's `.env` or `bunfig.toml` (architecture "Compile flags").
// Both binaries are built with Dovet's real compile options. `dovet` can't start child processes yet, so the probe
// (same options, different entry) shows what reaches a child's environment.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../../package.json";
import { compileDovet } from "../../../scripts/build.ts";

const EXE = process.platform === "win32" ? ".exe" : "";
let dir = "";
let planted = "";
let empty = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dovet-compile-"));
  await compileDovet({ outfile: join(dir, `dovet${EXE}`) });
  await compileDovet({ entry: join(import.meta.dir, "env-probe.ts"), outfile: join(dir, `probe${EXE}`) });
  planted = join(dir, "project");
  empty = join(dir, "empty");
  mkdirSync(planted);
  mkdirSync(empty);
  writeFileSync(join(planted, ".env"), "X_TEST=1\n");
  writeFileSync(join(planted, "preload.js"), 'console.log("BUNFIG PRELOAD RAN");\n');
  writeFileSync(join(planted, "bunfig.toml"), 'preload = ["./preload.js"]\n');
}, 120_000);

afterAll(() => {
  // Windows may still hold the just-run executables open for a moment.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function run(exe: string, ...args: string[]): string {
  const { X_TEST: _, ...env } = process.env;
  const r = Bun.spawnSync([join(dir, `${exe}${EXE}`), ...args], { cwd: planted, env });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString() + r.stderr.toString();
}

describe("compiled binary in a project with .env and bunfig.toml", () => {
  // spec: AC-ARCH-01
  test("dovet prints its version and does not run the project's bunfig.toml", () => {
    const out = run("dovet", "--version");
    expect(out).toContain(`dovet ${pkg.version}`);
    expect(out).not.toContain("BUNFIG PRELOAD RAN");
  });

  // spec: AC-ARCH-01
  test(".env is not loaded: X_TEST is absent in the process and in its child processes", () => {
    const out = run("probe", empty);
    expect(out).toContain("self X_TEST=<absent>");
    expect(out).toContain("child X_TEST=<absent>");
    expect(out).not.toContain("BUNFIG PRELOAD RAN");
  });
});
