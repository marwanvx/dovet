// Windows backend selection and status text (permissions §7.6, ADR-6).
import { describe, expect, test } from "bun:test";
import { selectWindowsBackend, windowsStatusText } from "./windows.ts";

describe("windows backend selection", () => {
  // spec: permissions §7.6
  test("MXC first, then srt-windows, then none", () => {
    expect(selectWindowsBackend({ mxcSupported: true, srtInstalled: true }).backend).toBe("mxc");
    expect(selectWindowsBackend({ mxcSupported: true, srtInstalled: false }).backend).toBe("mxc");
    expect(selectWindowsBackend({ mxcSupported: false, srtInstalled: true }).backend).toBe("srt-windows");
    expect(selectWindowsBackend({ mxcSupported: false, srtInstalled: false }).backend).toBe("none");
  });
});

describe("windows status text", () => {
  // spec: permissions §7.6
  test("an active native backend is experimental; none says judged by text", () => {
    expect(windowsStatusText({ backend: "srt-windows", state: "experimental" })).toContain("experimental");
    expect(windowsStatusText({ backend: "mxc", state: "experimental" })).toContain("mxc");
    expect(windowsStatusText({ backend: "none", state: "off" })).toContain("judged by text");
  });
});
