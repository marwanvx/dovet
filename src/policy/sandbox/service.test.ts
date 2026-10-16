// SandboxService tests: health gating, config hygiene, status line (AC-PERM-09, 10, 24, 25, 28).
import { describe, expect, test } from "bun:test";
import { Settings } from "../../schema/index.ts";
import { createSandboxService, fakeSandboxService, sandboxConfigFor, sandboxStatus } from "./service.ts";

// spec: AC-PERM-28
describe("sandbox status", () => {
  test("off says commands are judged by text; on names the backend", () => {
    expect(sandboxStatus("off", "none")).toContain("judged by text");
    expect(sandboxStatus("on", "bubblewrap")).toContain("bubblewrap");
    expect(sandboxStatus("weak", "bubblewrap")).toBe("sandbox: weak");
  });

  test("github.com allowed and WebFetch allow rules feed the allowlist; denied hosts stay denied", () => {
    const base = {
      os: "linux" as const,
      srtDir: "install/libexec/srt",
      settings: Settings.parse({
        sandbox: { network: { allowedDomains: ["github.com."], deniedDomains: ["evil.example."] } },
        permissions: { allow: ["WebFetch(domain:extra.example.com)"] },
      }),
      workingDirs: ["/work/proj"],
      sessionId: "s1",
      configDir: "/cfg",
      dataDir: "/data",
      home: "/home/u",
    };
    const c = sandboxConfigFor(base, "/tmp/sess");
    expect(c.allowedDomains).toContain("github.com");
    expect(c.allowedDomains).toContain("extra.example.com");
    expect(c.deniedDomains).toContain("evil.example");
  });
});

// spec: AC-PERM-24
describe("sandbox config", () => {
  const base = {
    os: "linux" as const,
    srtDir: "install/libexec/srt",
    settings: Settings.parse({}),
    workingDirs: ["/work/proj"],
    sessionId: "s1",
    configDir: "/cfg",
    dataDir: "/data",
    home: "/home/u",
  };
  test("denyRead strips the trailing slash so ~/.aws/ still blocks", () => {
    const c = sandboxConfigFor(
      { ...base, settings: Settings.parse({ sandbox: { filesystem: { denyRead: ["~/.aws/"] } } }) },
      "/tmp/sess",
    );
    expect(c.denyRead).toContain("/home/u/.aws");
    expect(c.denyRead).not.toContain("/home/u/.aws/");
  });

  test("protected writes are anchored and credential denies are defaults", () => {
    const c = sandboxConfigFor(base, "/tmp/sess");
    expect(c.denyWrite).toContain("/work/proj/.git/hooks");
    expect(c.denyWrite).toContain("/work/proj/.dovet/settings.json");
    expect(c.denyWrite).toContain("/work/proj/.dovet/settings.local.json");
    expect(c.denyWrite).toContain("/work/proj/.claude/settings.json");
    expect(c.denyWrite).not.toContain("/work/proj/hooks");
    expect(c.denyRead).toContain("/home/u/.aws");
    expect(c.denyRead).toContain("/home/u/.ssh");
    expect(c.allowedDomains).toContain("registry.npmjs.org");
  });

  test("glob warnings are exposed without blocking startup", async () => {
    const svc = createSandboxService({
      ...base,
      settings: Settings.parse({ sandbox: { filesystem: { denyRead: ["~/**/.env"] } } }),
      starter: (async () => ({
        checkDependencies: () => ({ errors: [], warnings: [] }),
        getLinuxGlobPatternWarnings: () => ["~/**/.env"],
        getSandboxViolationStore: () => ({ getViolations: () => [] }),
        wrapWithSandbox: async (c: string) => `wrapped:${c}`,
        cleanupAfterCommand: () => {},
      })) as never,
    });
    await svc.ready;
    expect(svc.state).toBe("on");
    expect(svc.globWarnings()).toEqual(["~/**/.env"]);
  });
});

// spec: AC-PERM-09
describe("health gating", () => {
  test("auto-allow needs a healthy sandbox: off never wraps", async () => {
    const off = fakeSandboxService("off", "none");
    const wrapped = await off.wrap({ argv: ["/bin/bash", "x.sh"], cwd: "/w", env: { A: "1" } }, { unsandboxed: false });
    expect(wrapped.argv).toEqual(["/bin/bash", "x.sh"]);
    const on = fakeSandboxService("on", "bubblewrap");
    expect(on.state).toBe("on");
  });

  test("the real service goes off when dependencies error and on when healthy", async () => {
    const baseOpts = {
      os: "linux" as const,
      srtDir: "install/libexec/srt",
      settings: Settings.parse({}),
      workingDirs: ["/work"],
      sessionId: "health-test",
      configDir: "/cfg",
      dataDir: "/data",
      home: "/home/u",
    };
    const bad = createSandboxService({
      ...baseOpts,
      starter: (async () => ({
        checkDependencies: () => ({ errors: ["bwrap missing"], warnings: [] }),
        getLinuxGlobPatternWarnings: () => [],
        getSandboxViolationStore: () => ({ getViolations: () => [] }),
        wrapWithSandbox: async (c: string) => c,
        cleanupAfterCommand: () => {},
      })) as never,
    });
    await bad.ready;
    expect(bad.state).toBe("off");
    const passthrough = await bad.wrap({ argv: ["/bin/bash", "x"], cwd: "/w", env: {} }, { unsandboxed: false });
    expect(passthrough.argv).toEqual(["/bin/bash", "x"]);
    const good = createSandboxService({
      ...baseOpts,
      starter: (async () => ({
        checkDependencies: () => ({ errors: [], warnings: [] }),
        getLinuxGlobPatternWarnings: () => [],
        getSandboxViolationStore: () => ({ getViolations: () => [] }),
        wrapWithSandbox: async (c: string) => `wrapped:${c}`,
        cleanupAfterCommand: () => {},
      })) as never,
    });
    await good.ready;
    expect(good.state).toBe("on");
  });

  test("a starter that throws leaves the service off instead of hanging", async () => {
    const svc = createSandboxService({
      os: "linux" as const,
      srtDir: "install/libexec/srt",
      settings: Settings.parse({}),
      workingDirs: ["/work"],
      sessionId: "throw-test",
      configDir: "/cfg",
      dataDir: "/data",
      home: "/home/u",
      starter: (async () => {
        throw new Error("no sandbox");
      }) as never,
    });
    await svc.ready;
    expect(svc.state).toBe("off");
  });
});

// spec: AC-PERM-24
describe("per-command denies", () => {
  test("wrap unions startup and per-command denies without duplicates", async () => {
    let captured: { denyWrite?: string[] } | undefined;
    const svc = createSandboxService({
      os: "linux" as const,
      srtDir: "install/libexec/srt",
      settings: Settings.parse({}),
      workingDirs: ["/work/a"],
      sessionId: "union-test",
      configDir: "/cfg",
      dataDir: "/data",
      home: "/home/u",
      starter: (async () => ({
        checkDependencies: () => ({ errors: [], warnings: [] }),
        getLinuxGlobPatternWarnings: () => [],
        getSandboxViolationStore: () => ({ getViolations: () => [] }),
        wrapWithSandbox: async (_c: string, _b: unknown, custom?: { filesystem?: { denyWrite?: string[] } }) => {
          const denies = custom?.filesystem?.denyWrite;
          captured = denies === undefined ? {} : { denyWrite: denies };
          return `wrapped:${_c}`;
        },
        cleanupAfterCommand: () => {},
      })) as never,
    });
    await svc.ready;
    expect(svc.state).toBe("on");
    await svc.wrap({ argv: ["/bin/bash", "x"], cwd: "/work/b", env: {} }, { unsandboxed: false });
    const denies = captured?.denyWrite ?? [];
    expect(denies).toContain("/work/a/.git/hooks");
    expect(denies).toContain("/work/b/.git/hooks");
    expect(denies).toContain("/work/b/.dovet/settings.json");
    expect(new Set(denies).size).toBe(denies.length);
  });
});

// spec: AC-PERM-25
describe("violations passthrough", () => {
  test("a fake service passes violations through even when the command succeeds", () => {
    const svc = fakeSandboxService("on", "bubblewrap", ["blocked host: example.com (denied)"]);
    expect(svc.violations(Date.now() - 1000)).toEqual(["blocked host: example.com (denied)"]);
  });
});
