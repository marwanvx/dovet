import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SRT_HELPER_FILES, sandboxRuntimeConfig, srtHelpersFor } from "./init.ts";

const srtDir = join("install", "libexec", "srt");

describe("sandboxRuntimeConfig", () => {
  test("Linux: seccomp, Java agent and ripgrep are explicit paths into libexec", () => {
    const c = sandboxRuntimeConfig({ os: "linux", srtDir, rgPath: "/i/libexec/rg", allowWrite: ["/work"] });
    expect(c.seccomp?.applyPath).toBe(join(srtDir, "apply-seccomp"));
    expect(c.javaAgentJarPath).toBe(join(srtDir, "srt-proxy-agent.jar"));
    expect(c.ripgrep?.command).toBe("/i/libexec/rg");
    expect(c.windows).toBeUndefined();
    expect(c.filesystem?.allowWrite).toEqual(["/work"]);
  });

  test("Windows: srt-win is an explicit path and there is no seccomp", () => {
    const c = sandboxRuntimeConfig({ os: "win32", srtDir, allowWrite: ["C:\\work"] });
    expect(c.windows?.srtWin?.path).toBe(join(srtDir, "srt-win.exe"));
    expect(c.seccomp).toBeUndefined();
    expect(c.ripgrep).toBeUndefined();
  });

  test("macOS needs only the Java agent", () => {
    const c = sandboxRuntimeConfig({ os: "darwin", srtDir, allowWrite: ["/work"] });
    expect(c.seccomp).toBeUndefined();
    expect(c.windows).toBeUndefined();
  });

  test("the archive ships exactly the files the config points at", () => {
    expect(srtHelpersFor("linux")).toEqual([SRT_HELPER_FILES.javaAgent, SRT_HELPER_FILES.seccomp]);
    expect(srtHelpersFor("darwin")).toEqual([SRT_HELPER_FILES.javaAgent]);
    expect(srtHelpersFor("win32")).toEqual([SRT_HELPER_FILES.javaAgent, SRT_HELPER_FILES.srtWin]);
  });
});
