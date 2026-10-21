import { describe, expect, test } from "bun:test";
import { isPolicyRefusal } from "./powershell-script.ts";

describe("isPolicyRefusal", () => {
  // spec: AC-TOOLS-28
  test("sees the refusal when the console wraps its sentence between words, as a long script path makes it", () => {
    const wrapped =
      "File C:\\Users\\runneradmin\\AppData\\Local\\Temp\\dovet-testrun-AFr0c2\\dovet-tool-HF9mUJ\\ps\\53d70961.ps1 cannot be loaded. \n" +
      "The file C:\\Users\\runneradmin\\AppData\\Local\\Temp\\dovet-testrun-AFr0c2\\dovet-tool-HF9mUJ\\ps\\53d70961.ps1 is not \n" +
      "digitally signed. You cannot run this script on the current system.";
    expect(isPolicyRefusal(wrapped)).toBe(true);
    expect(isPolicyRefusal("running scripts is\r\ndisabled on this system")).toBe(true);
  });

  test("does not take ordinary output for a refusal", () => {
    expect(isPolicyRefusal("hello\nthe file is signed\n")).toBe(false);
  });
});
