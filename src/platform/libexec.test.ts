// Where Dovet finds the helpers that ship beside it (architecture "Distribution", interfaces §Platform.libexec).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { libexecPath } from "./libexec.ts";

describe("libexecPath", () => {
  test("rg sits in libexec/ next to the executable", () => {
    expect(libexecPath(join("/opt", "dovet", "versions", "1.2.3", "dovet"), "linux", "rg")).toBe(
      join("/opt", "dovet", "versions", "1.2.3", "libexec", "rg"),
    );
    expect(libexecPath(join("/Users", "x", "dovet"), "darwin", "rg")).toBe(join("/Users", "x", "libexec", "rg"));
  });

  test("on Windows the helper is rg.exe", () => {
    expect(libexecPath(join("C:", "dovet", "dovet.exe"), "win32", "rg")).toBe(join("C:", "dovet", "libexec", "rg.exe"));
  });

  test("srt is a directory of vendor files", () => {
    expect(libexecPath(join("/opt", "dovet", "dovet"), "linux", "srt")).toBe(join("/opt", "dovet", "libexec", "srt"));
  });
});
