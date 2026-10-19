// Windows MXC backend mapping and availability (permissions §7.6, ADR-6, SPIKE-42).
import { describe, expect, test } from "bun:test";
import { checkMxcSupport, mxcConfigFor } from "./mxc.ts";

describe("mxc config", () => {
  // spec: permissions §7.6
  test("write roots become readwritePaths and credential denies become deniedPaths", () => {
    const c = mxcConfigFor({
      allowWrite: ["C:\\work\\proj"],
      denyRead: ["C:\\Users\\u\\.ssh", "C:\\shared"],
      denyWrite: ["C:\\work\\proj\\.git\\hooks", "C:\\shared"],
    });
    expect(c.readwritePaths).toEqual(["C:\\work\\proj"]);
    expect(c.deniedPaths).toContain("C:\\Users\\u\\.ssh");
    expect(c.deniedPaths).toContain("C:\\work\\proj\\.git\\hooks");
    expect(c.deniedPaths.filter((p) => p === "C:\\shared")).toHaveLength(1);
    expect(new Set(c.deniedPaths).size).toBe(c.deniedPaths.length);
  });
});

describe("mxc availability", () => {
  // spec: permissions §7.6
  test("supported host reports supported", async () => {
    const s = await checkMxcSupport(async () => ({ getPlatformSupport: () => ({ isSupported: true }) }));
    expect(s.supported).toBe(true);
  });

  // spec: permissions §7.6
  test("unsupported host and a missing SDK both report unsupported without throwing", async () => {
    const off = await checkMxcSupport(async () => ({ getPlatformSupport: () => ({ isSupported: false }) }));
    expect(off.supported).toBe(false);
    const missing = await checkMxcSupport(async () => {
      throw new Error("Cannot find module");
    });
    expect(missing.supported).toBe(false);
    expect(missing.detail).toContain("unavailable");
  });

  // spec: permissions §7.6
  test("malformed SDK output fails closed with unexpected format detail", async () => {
    const malformed = await checkMxcSupport(async () => ({ getPlatformSupport: () => ({ isSupported: "truthy" }) }));
    expect(malformed.supported).toBe(false);
    expect(malformed.detail).toMatch(/unexpected format/i);
    const nonObject = await checkMxcSupport(async () => ({ getPlatformSupport: () => "invalid" }));
    expect(nonObject.supported).toBe(false);
    expect(nonObject.detail).toMatch(/unexpected format/i);
  });
});
