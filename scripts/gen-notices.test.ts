import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS } from "./build-release.ts";
import { bundledPackageDirs, releaseNotices } from "./gen-notices.ts";

const ROOT = join(import.meta.dir, "..");
const NM = join(ROOT, "node_modules");
const work = mkdtempSync(join(tmpdir(), "dovet-notices-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const linux = TARGETS.find((t) => t.id === "linux-x64");
const muslArm = TARGETS.find((t) => t.id === "linux-arm64-musl");
if (!linux || !muslArm) throw new Error("targets missing");

describe("bundledPackageDirs", () => {
  test("maps bundled files to their npm package directories, scoped and nested, once each", () => {
    const dirs = bundledPackageDirs([
      join(NM, "marked", "lib", "marked.esm.js"),
      join(NM, "marked", "package.json"),
      join(NM, "@scope", "pkg", "dist", "a.js"),
      join(NM, "outer", "node_modules", "inner", "index.js"),
      join(ROOT, "src", "cli", "main.ts"),
    ]);
    expect(dirs).toEqual([join(NM, "@scope", "pkg"), join(NM, "marked"), join(NM, "outer", "node_modules", "inner")]);
  });
});

describe("releaseNotices", () => {
  // spec: AC-ARCH-05
  test("lists each bundled package with its license text and NOTICE file, plus Bun, sandbox-runtime and ripgrep", async () => {
    const withNotice = join(work, "node_modules", "with-notice");
    mkdirSync(withNotice, { recursive: true });
    writeFileSync(
      join(withNotice, "package.json"),
      JSON.stringify({ name: "with-notice", version: "2.0.0", license: "Apache-2.0" }),
    );
    writeFileSync(join(withNotice, "LICENSE"), "Apache License text of with-notice\n");
    writeFileSync(join(withNotice, "NOTICE"), "with-notice NOTICE: Copyright Example Corp\n");

    const text = await releaseNotices({
      inputs: [join(NM, "marked", "lib", "marked.esm.js"), join(withNotice, "index.js")],
      target: linux,
      ripgrepLicense: "ripgrep MIT text\n",
    });
    expect(text).toContain("marked 18.0.11");
    expect(text).toContain(readFileSync(join(NM, "marked", "LICENSE"), "utf8").trim());
    expect(text).toContain("with-notice 2.0.0");
    expect(text).toContain("License: Apache-2.0");
    expect(text).toContain("Apache License text of with-notice");
    expect(text).toContain("with-notice NOTICE: Copyright Example Corp");
    expect(text).toContain("ripgrep 15.1.0");
    expect(text).toContain("ripgrep MIT text");
    expect(text).toContain("@anthropic-ai/sandbox-runtime 0.0.79");
    expect(text).toContain(readFileSync(join(NM, "@anthropic-ai", "sandbox-runtime", "LICENSE"), "utf8").trim());
    expect(text).toContain("Bun 1.4.3");
    expect(text).toContain("Bun statically links JavaScriptCore");
    expect(text).toContain("pi-tui");
  });

  // spec: AC-ARCH-05
  test("the release build fails when a bundled package has no license file", async () => {
    const bare = join(work, "node_modules", "no-license");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "no-license", version: "1.0.0", license: "MIT" }));
    await expect(
      releaseNotices({ inputs: [join(bare, "index.js")], target: linux, ripgrepLicense: "x" }),
    ).rejects.toThrow("no-license 1.0.0 has no license file");
  });

  test("a target without bundled ripgrep lists no ripgrep", async () => {
    const text = await releaseNotices({ inputs: [], target: muslArm, ripgrepLicense: null });
    expect(text).not.toContain("ripgrep");
  });

  test("a target with bundled ripgrep needs its license", async () => {
    await expect(releaseNotices({ inputs: [], target: linux, ripgrepLicense: null })).rejects.toThrow("ripgrep");
  });
});
