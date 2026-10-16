// Windows backends behind SandboxService (permissions §7.6): srt-windows runs experimental, MXC stays off.
import { describe, expect, test } from "bun:test";
import { Settings } from "../../schema/index.ts";
import { backendFor, createSandboxService } from "./service.ts";

const base = {
  srtDir: "install/libexec/srt",
  settings: Settings.parse({}),
  workingDirs: ["/work"],
  sessionId: "win-test",
  configDir: "/cfg",
  dataDir: "/data",
  home: "/home/u",
};

function srtStarter(captured: {
  argv?: string[] | undefined;
  custom?: { filesystem?: { allowWrite?: string[] } | undefined } | undefined;
}) {
  return (async () => ({
    checkDependencies: () => ({ errors: [], warnings: [] }),
    getLinuxGlobPatternWarnings: () => [],
    getSandboxViolationStore: () => ({ getViolations: () => [] }),
    wrapWithSandboxArgv: async (c: string, _b: unknown, custom?: { filesystem?: { allowWrite?: string[] } }) => {
      captured.argv = ["srt-win", "exec", c];
      captured.custom = custom === undefined ? {} : { filesystem: custom.filesystem };
      return { argv: ["srt-win", "exec", c], env: { A: "1" } };
    },
    wrapWithSandbox: async (c: string) => `wrapped:${c}`,
    cleanupAfterCommand: () => {},
  })) as never;
}

describe("windows backends", () => {
  // spec: permissions §7.6
  test("backendFor selects the Windows backend", () => {
    expect(backendFor("win32", "srt-windows")).toBe("srt-windows");
    expect(backendFor("win32", "mxc")).toBe("mxc");
    expect(backendFor("win32")).toBe("none");
    expect(backendFor("linux")).toBe("bubblewrap");
  });

  // spec: permissions §7.6
  test("srt-windows runs experimental and wraps via argv", async () => {
    const captured: {
      argv?: string[] | undefined;
      custom?: { filesystem?: { allowWrite?: string[] } | undefined } | undefined;
    } = {};
    const svc = createSandboxService({
      ...base,
      os: "win32",
      windowsBackend: "srt-windows",
      starter: srtStarter(captured),
    });
    await svc.ready;
    expect(svc.backend).toBe("srt-windows");
    expect(svc.state).toBe("experimental");
    const wrapped = await svc.wrap({ argv: ["git", "status"], cwd: "/work", env: {} }, { unsandboxed: false });
    expect(wrapped.argv[0]).toBe("srt-win");
    expect(captured.argv).toBeDefined();
    expect(captured.custom?.filesystem?.allowWrite).toBeUndefined();
  });

  // spec: permissions §7.6
  test("mxc stays off until its execution lands; none stays off", async () => {
    const argv = ["git", "status"];
    const mxc = createSandboxService({ ...base, os: "win32", windowsBackend: "mxc" });
    await mxc.ready;
    expect(mxc.backend).toBe("mxc");
    expect(mxc.state).toBe("off");
    expect((await mxc.wrap({ argv, cwd: "/work", env: {} }, { unsandboxed: false })).argv).toEqual(argv);
    const none = createSandboxService({ ...base, os: "win32" });
    await none.ready;
    expect(none.backend).toBe("none");
    expect(none.state).toBe("off");
    expect((await none.wrap({ argv, cwd: "/work", env: {} }, { unsandboxed: false })).argv).toEqual(argv);
  });

  // spec: permissions §7.6
  test("srt-windows with dependency errors goes off and passes through", async () => {
    const svc = createSandboxService({
      ...base,
      os: "win32",
      windowsBackend: "srt-windows",
      starter: (async () => ({
        checkDependencies: () => ({ errors: ["srt-win missing"], warnings: [] }),
        getLinuxGlobPatternWarnings: () => [],
        getSandboxViolationStore: () => ({ getViolations: () => [] }),
        wrapWithSandboxArgv: async (c: string) => ({ argv: [c], env: {} }),
        wrapWithSandbox: async (c: string) => c,
        cleanupAfterCommand: () => {},
      })) as never,
    });
    await svc.ready;
    expect(svc.state).toBe("off");
    expect((await svc.wrap({ argv: ["git", "status"], cwd: "/work", env: {} }, { unsandboxed: false })).argv).toEqual([
      "git",
      "status",
    ]);
  });
});
