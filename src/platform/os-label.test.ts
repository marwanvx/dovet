import { describe, expect, test } from "bun:test";
import { describeOs } from "./os-label.ts";

const files =
  (map: Record<string, string>) =>
  (path: string): Promise<string> => {
    const text = map[path];
    if (text !== undefined) return Promise.resolve(text);
    return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }));
  };

describe("describeOs", () => {
  test("Linux uses PRETTY_NAME from os-release, else the kernel release", async () => {
    const osRelease = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n';
    expect(await describeOs("linux", "6.8.0", files({ "/etc/os-release": osRelease }))).toBe("Ubuntu 24.04.1 LTS");
    expect(await describeOs("linux", "6.8.0", files({ "/usr/lib/os-release": "PRETTY_NAME=Arch Linux\n" }))).toBe(
      "Arch Linux",
    );
    expect(await describeOs("linux", "6.8.0", files({}))).toBe("Linux 6.8.0");
  });

  test("macOS reads the product version without running a program", async () => {
    const plist = "<dict>\n\t<key>ProductVersion</key>\n\t<string>15.3</string>\n</dict>";
    const path = "/System/Library/CoreServices/SystemVersion.plist";
    expect(await describeOs("darwin", "24.3.0", files({ [path]: plist }))).toBe("macOS 15.3");
    expect(await describeOs("darwin", "24.3.0", files({}))).toBe("macOS (Darwin 24.3.0)");
  });

  test("Windows 11 starts at build 22000", async () => {
    expect(await describeOs("win32", "10.0.26100", files({}))).toBe("Windows 11 (build 26100)");
    expect(await describeOs("win32", "10.0.19045", files({}))).toBe("Windows 10 (build 19045)");
  });
});
