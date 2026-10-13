// Dovet resolves every program it spawns itself, never from the project or the cwd (platforms "Executable resolution").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { createExecResolver, createPlatformCore } from "../../../src/platform/index.ts";
import type { AbsPath } from "../../../src/schema/index.ts";
import { type TempProject, tempProject } from "../../helpers/index.ts";

const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const exe = os === "win32" ? ".exe" : "";
const realGit = Bun.which("git");

let project: TempProject;
let outside: TempProject;
let marker: string;
let planted: string[];

beforeAll(async () => {
  project = await tempProject();
  outside = await tempProject();
  marker = join(outside.root, "marker.txt");
  const preload = join(outside.root, "preload.ts");
  await writeFile(preload, `await Bun.write(${JSON.stringify(marker)}, "executed");\n`);
  // A copy of Bun named like the tool: if anything runs it, the preload writes the marker.
  const bunCopy = join(project.root, `git${exe}`);
  copyFileSync(process.execPath, bunCopy);
  chmodSync(bunCopy, 0o755);
  const rgCopy = join(project.root, `rg${exe}`);
  linkSync(bunCopy, rgCopy);
  planted = [bunCopy, rgCopy];
});

afterAll(async () => {
  await project.dispose();
  await outside.dispose();
});

function pathWith(...dirs: string[]): Record<string, string> {
  return { PATH: dirs.join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
}

describe("executable resolution", () => {
  // spec: AC-PLAT-05
  test("planted git and rg in the project root are never resolved, even with '.', '' and the project on PATH", async () => {
    expect(realGit).toBeString();
    const realDir = dirname(realGit as string);
    const resolver = createExecResolver({
      os,
      env: pathWith("", ".", project.root, realDir),
      projectRoot: project.root as AbsPath,
    });
    const git = await resolver.resolve("git");
    expect(git?.toLowerCase()).toBe(join(realDir, `git${exe}`).toLowerCase());
    const rg = await resolver.resolve("rg");
    expect(planted).not.toContain(rg);
    if (rg !== undefined) expect(rg.toLowerCase().startsWith(project.root.toLowerCase())).toBe(false);
  });

  // spec: AC-PLAT-05
  test("running what Dovet resolved never executes the planted binaries", async () => {
    const realDir = dirname(realGit as string);
    const env = {
      ...pathWith("", ".", project.root, realDir),
      BUN_OPTIONS: `--preload ${join(outside.root, "preload.ts")}`,
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    };
    const platform = createPlatformCore({
      os,
      arch: process.arch,
      execPath: process.execPath,
      env,
      projectRoot: project.root as AbsPath,
      kill: (pid, signal) => process.kill(pid, signal),
    });
    const git = await platform.resolve("git");
    expect(git).toBeString();
    const child = platform.spawn({
      argv: [git as string, "--version"],
      cwd: project.root as AbsPath,
      env,
      signal: new AbortController().signal,
      group: "resolved",
    });
    expect(await new Response(child.stdout).text()).toStartWith("git version");
    expect(await child.exited).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  // spec: AC-PLAT-05
  test("without a real copy elsewhere on PATH the tool counts as missing", async () => {
    const resolver = createExecResolver({
      os,
      env: pathWith("", ".", project.root),
      projectRoot: project.root as AbsPath,
    });
    expect(await resolver.resolve("git")).toBeUndefined();
  });

  test("a missing tool is remembered as missing for the session", async () => {
    const dir = join(outside.root, "bin-late");
    mkdirSync(dir);
    const resolver = createExecResolver({ os, env: pathWith(dir), projectRoot: project.root as AbsPath });
    expect(await resolver.resolve("late-tool")).toBeUndefined();
    writeFileSync(join(dir, `late-tool${exe}`), "#!/bin/sh\n");
    chmodSync(join(dir, `late-tool${exe}`), 0o755);
    expect(await resolver.resolve("late-tool")).toBeUndefined();
    const fresh = createExecResolver({ os, env: pathWith(dir), projectRoot: project.root as AbsPath });
    expect(await fresh.resolve("late-tool")).toBe(join(dir, `late-tool${exe}`));
  });

  test("relative PATH entries are skipped", async () => {
    const resolver = createExecResolver({
      os,
      env: pathWith("node_modules/.bin", "bin"),
      projectRoot: project.root as AbsPath,
    });
    expect(await resolver.resolve("git")).toBeUndefined();
  });

  test("a name with a path separator is refused rather than searched", async () => {
    const resolver = createExecResolver({ os, env: pathWith(project.root), projectRoot: project.root as AbsPath });
    await expect(resolver.resolve("../git")).rejects.toThrow(/program name/);
  });

  test.if(os !== "win32")("a PATH directory that is a symlink into the project is skipped", async () => {
    const via = join(outside.root, "via-link");
    symlinkSync(project.root, via);
    const resolver = createExecResolver({ os, env: pathWith(via), projectRoot: project.root as AbsPath });
    expect(await resolver.resolve("git")).toBeUndefined();
  });

  test.if(os !== "win32")("a file without the execute bit is not an executable", async () => {
    const dir = join(outside.root, "bin-noexec");
    mkdirSync(dir);
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n");
    chmodSync(join(dir, "tool"), 0o644);
    const resolver = createExecResolver({ os, env: pathWith(dir), projectRoot: project.root as AbsPath });
    expect(await resolver.resolve("tool")).toBeUndefined();
  });

  test.if(os !== "win32")("a lookup that fails is not cached as an answer", async () => {
    const resolver = createExecResolver({ os, env: pathWith(outside.root), projectRoot: project.root as AbsPath });
    const tooLong = "x".repeat(300);
    const first = resolver.resolve(tooLong);
    await expect(first).rejects.toThrow();
    const second = resolver.resolve(tooLong);
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  });

  test.if(os === "win32")("Windows runs only .exe and .com, never a batch file through cmd.exe", async () => {
    const dir = join(outside.root, "bin-bat");
    mkdirSync(dir);
    writeFileSync(join(dir, "tool.cmd"), "@echo off");
    const resolver = createExecResolver({
      os,
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      projectRoot: project.root as AbsPath,
    });
    expect(await resolver.resolve("tool")).toBeUndefined();
    expect(await resolver.resolve("tool.cmd")).toBeUndefined();
  });

  test.if(os === "win32")("Windows adds PATHEXT and finds the variable under any case", async () => {
    const dir = join(outside.root, "bin-win");
    mkdirSync(dir);
    writeFileSync(join(dir, "tool.exe"), "MZ");
    const resolver = createExecResolver({
      os,
      env: { Path: dir, pathext: ".EXE" },
      projectRoot: project.root as AbsPath,
    });
    expect((await resolver.resolve("tool"))?.toLowerCase()).toBe(join(dir, "tool.exe").toLowerCase());
  });
});
