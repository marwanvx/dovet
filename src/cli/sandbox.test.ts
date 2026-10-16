// dovet sandbox install/uninstall/status (cli-config).
import { describe, expect, test } from "bun:test";
import { runSandboxCommand, sandboxStatusText } from "./sandbox.ts";

describe("sandbox status text", () => {
  // spec: permissions §7.6
  test("names the backend and the experimental label; off says judged by text", () => {
    expect(sandboxStatusText({ os: "win32", backend: "mxc", state: "experimental" })).toContain("experimental");
    expect(sandboxStatusText({ os: "win32", backend: "srt-windows", state: "experimental" })).toContain("srt-windows");
    expect(sandboxStatusText({ os: "linux", backend: "bubblewrap", state: "on" })).toContain("bubblewrap");
    expect(sandboxStatusText({ os: "win32", backend: "none", state: "off" })).toContain("judged by text");
  });
});

describe("sandbox command", () => {
  // spec: permissions §7.6
  test("status prints the backend; install off Windows refuses", async () => {
    const status = await runSandboxCommand(["status"], {
      os: "linux",
      backend: "bubblewrap",
      state: "on",
      check: async () => ({ provisioned: false, detail: "n/a" }),
      install: async () => ({}),
      uninstall: async () => ({}),
    });
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain("bubblewrap");
    const install = await runSandboxCommand(["install"], {
      os: "linux",
      backend: "none",
      state: "off",
      check: async () => ({ provisioned: false, detail: "n/a" }),
      install: async () => ({}),
      uninstall: async () => ({}),
    });
    expect(install.exitCode).toBe(2);
    expect(install.output).toMatch(/Windows/i);
  });

  // spec: permissions §7.6
  test("unknown subcommand is usage error", async () => {
    const r = await runSandboxCommand(["bogus"], {
      os: "win32",
      backend: "none",
      state: "off",
      check: async () => ({ provisioned: false, detail: "n/a" }),
      install: async () => ({}),
      uninstall: async () => ({}),
    });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("usage");
  });

  // spec: permissions §7.6
  test("win32 status names the install state; install/uninstall report done or cancelled", async () => {
    const win = {
      os: "win32",
      backend: "srt-windows" as const,
      state: "experimental" as const,
      check: async () => ({ provisioned: true, detail: "MXC SDK unavailable" }),
      install: async () => ({}),
      uninstall: async () => ({}),
    };
    const status = await runSandboxCommand(["status"], win);
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain("srt-windows");
    expect(status.output).toContain("installed");
    const install = await runSandboxCommand(["install"], win);
    expect(install).toEqual({ output: "install done\n", exitCode: 0 });
    const cancelled = await runSandboxCommand(["install"], {
      ...win,
      install: async () => ({ cancelled: true as const }),
    });
    expect(cancelled).toEqual({ output: "install cancelled (UAC dismissed)\n", exitCode: 1 });
    const uninstall = await runSandboxCommand(["uninstall"], win);
    expect(uninstall).toEqual({ output: "uninstall done\n", exitCode: 0 });
  });

  // spec: permissions §7.6
  test("uninstall off Windows refuses", async () => {
    const r = await runSandboxCommand(["uninstall"], {
      os: "linux",
      backend: "none",
      state: "off",
      check: async () => ({ provisioned: false, detail: "n/a" }),
      install: async () => ({}),
      uninstall: async () => ({}),
    });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("Windows only");
  });
});
