// Windows escape suite (permissions §7.6): records the backend label on Windows CI (QUESTIONS Q59).
import { describe, expect, test } from "bun:test";

const WINDOWS = process.platform === "win32";

describe.skipIf(!WINDOWS)("windows escape suite", () => {
  // spec: permissions §7.6
  test("the label stays experimental-or-off", async () => {
    const { checkMxcSupport, createSandboxService, selectWindowsBackend } = await import("../index.ts");
    const { Settings } = await import("../../schema/index.ts");
    const mxc = await checkMxcSupport();
    const sel = selectWindowsBackend({ mxcSupported: mxc.supported, srtInstalled: false });
    expect(["mxc", "none"]).toContain(sel.backend);
    const svc = createSandboxService({
      os: "win32",
      srtDir: "install\\libexec\\srt",
      settings: Settings.parse({}),
      workingDirs: ["C:\\work"],
      sessionId: "escape",
      configDir: "C:\\cfg",
      dataDir: "C:\\data",
      home: "C:\\Users\\u",
    });
    await svc.ready;
    expect(svc.backend).toBe("none");
    expect(svc.state).toBe("off");
    console.log(`escape suite: mxc=${mxc.supported} backend=${svc.backend} state=${svc.state} (${mxc.detail})`);
  });
});
