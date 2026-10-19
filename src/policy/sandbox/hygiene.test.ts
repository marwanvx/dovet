// Sandbox hygiene unit tests (permissions §7.5b, AC-PERM-24, AC-PERM-25).
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandProtectedSymlinks,
  isExcludedCommand,
  normalizeHost,
  normalizeSandboxPath,
  sandboxProtectedDenyWrite,
  worktreeCommonDenies,
} from "./hygiene.ts";

// spec: AC-PERM-24
describe("sandbox hygiene", () => {
  test("a trailing slash does not bypass a denyRead", () => {
    expect(normalizeSandboxPath("~/.aws/", "/home/u")).toBe("/home/u/.aws");
    expect(normalizeSandboxPath("~/.aws", "/home/u")).toBe("/home/u/.aws");
    expect(normalizeSandboxPath("~", "/home/u")).toBe("/home/u");
  });

  test("absolute paths need no // prefix and parens survive", () => {
    expect(normalizeSandboxPath("/home/u/my (dir)/", "/home/u")).toBe("/home/u/my (dir)");
    expect(normalizeSandboxPath("///home/u/.aws", "/home/u")).toBe("//home/u/.aws".slice(1));
  });

  test("hosts strip trailing dots, bracket bare IPv6, reject ambiguous spellings", () => {
    expect(normalizeHost("example.com.")).toEqual({ ok: true, host: "example.com" });
    expect(normalizeHost("registry.npmjs.org")).toEqual({ ok: true, host: "registry.npmjs.org" });
    expect(normalizeHost("::1")).toEqual({ ok: true, host: "[::1]" });
    expect(normalizeHost("[::1]:443")).toEqual({ ok: true, host: "[::1]:443" });
    expect(normalizeHost("not a host")).toEqual({ ok: false, reason: expect.any(String) });
    expect(normalizeHost("example..com")).toEqual({ ok: false, reason: expect.any(String) });
    expect(normalizeHost("")).toEqual({ ok: false, reason: expect.any(String) });
  });

  test("protected entries are anchored: a project dir named hooks/ stays writable", () => {
    const denies = sandboxProtectedDenyWrite(["/work/proj"], "/cfg", "/data");
    expect(denies).toContain("/work/proj/.git/hooks");
    expect(denies).toContain("/work/proj/.dovet/settings.json");
    expect(denies).toContain("/work/proj/.dovet/settings.local.json");
    expect(denies).toContain("/work/proj/.claude/settings.json");
    expect(denies).toContain("/work/proj/.git/config");
    expect(denies).not.toContain("/work/proj/hooks");
    expect(denies).not.toContain("/work/proj/config");
    expect(denies).toContain("/work/proj/.dovet");
    expect(denies).toContain("/work/proj/.mcp.json");
  });

  test("protected entries handle Windows drive paths without escaping root", () => {
    const denies = sandboxProtectedDenyWrite(["C:\\work\\proj"], "C:\\cfg", "C:\\data");
    expect(denies).toContain("C:/cfg");
    expect(denies).toContain("C:/data");
    expect(denies).toContain("C:/work/proj/.git/hooks");
    expect(denies).toContain("C:/.dovet");
    expect(denies.some((p) => p.startsWith("."))).toBe(false);
  });

  test("a linked worktree allows objects, refs and logs but denies hooks and config", () => {
    const denies = worktreeCommonDenies("/git/common");
    expect(denies).toEqual(["/git/common/hooks", "/git/common/config"]);
    expect(denies.join("\n")).not.toContain("objects");
    expect(denies.join("\n")).not.toContain("refs");
  });

  test("a symlinked protected path denies both link and target and never stops startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-hyg-"));
    const target = join(dir, "real-settings.json");
    await writeFile(target, "{}");
    const { lstat, symlink } = await import("node:fs/promises");
    const link = join(dir, ".dovet", "settings.json");
    await symlink(target, link).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, ".dovet"), { recursive: true });
      await symlink(target, link).catch(() => {});
    });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const expanded = await expandProtectedSymlinks([link, join(dir, "missing.json")]);
    expect(expanded).toContain(link);
    expect(expanded).toContain(target);
    const missingOk = await expandProtectedSymlinks([join(dir, "does-not-exist-12345")]);
    expect(missingOk).toEqual([join(dir, "does-not-exist-12345")]);
  });
});

// spec: AC-PERM-25
describe("excluded commands", () => {
  test("a compound command is excluded only when every part matches", () => {
    expect(isExcludedCommand("docker ps", ["docker *"])).toBe(true);
    expect(isExcludedCommand("docker ps && docker images", ["docker *"])).toBe(true);
    expect(isExcludedCommand("docker ps && ls", ["docker *"])).toBe(false);
    expect(isExcludedCommand("ls", ["docker *"])).toBe(false);
  });

  test("matching uses argv rules: env prefixes and git -b/--branch", () => {
    expect(isExcludedCommand("FOO=bar docker ps", ["docker *"])).toBe(false);
    expect(isExcludedCommand("git clone -b main https://h/x", ["git clone *"])).toBe(true);
    expect(isExcludedCommand("git clone --branch main https://h/x", ["git clone *"])).toBe(true);
    expect(isExcludedCommand('git commit -m "a # b"', ["git commit *"])).toBe(true);
  });

  test("powershell aliases canonicalize before matching", () => {
    expect(isExcludedCommand("ls C:\\work", ["Get-ChildItem *"], "PowerShell")).toBe(true);
    expect(isExcludedCommand("Get-ChildItem C:\\work", ["Get-ChildItem *"], "PowerShell")).toBe(true);
  });
});
