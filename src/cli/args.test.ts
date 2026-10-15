// Headless argument parsing (tui "Headless mode", cli-config "Commands").
import { describe, expect, test } from "bun:test";

// spec: AC-TUI-05
describe("parseHeadlessArgs", () => {
  test("parses -p with prompt and output formats", async () => {
    const { parseHeadlessArgs } = await import("./args.ts");
    expect(parseHeadlessArgs(["-p", "hello"])).toMatchObject({ print: true, prompt: "hello", output: "text" });
    expect(parseHeadlessArgs(["-p", "hi", "--output", "json"])).toMatchObject({ output: "json" });
    expect(parseHeadlessArgs(["-p", "hi", "--output", "stream-json"])).toMatchObject({ output: "stream-json" });
  });

  test("rejects an unknown output format with exit 2", async () => {
    const { parseHeadlessArgs } = await import("./args.ts");
    const r = parseHeadlessArgs(["-p", "hi", "--output", "yaml"]);
    expect(r).toMatchObject({ error: expect.stringContaining("--output"), exitCode: 2 });
  });

  test("collects repeatable tool rules and offline", async () => {
    const { parseHeadlessArgs } = await import("./args.ts");
    const r = parseHeadlessArgs([
      "-p",
      "hi",
      "--offline",
      "--allowedTools",
      "Read(*)",
      "--allowedTools",
      "Bash(npm *)",
      "--disallowedTools",
      "Bash(rm *)",
    ]);
    expect(r).toMatchObject({
      offline: true,
      allowedTools: ["Read(*)", "Bash(npm *)"],
      disallowedTools: ["Bash(rm *)"],
    });
  });

  test("rejects unknown flags with exit 2", async () => {
    const { parseHeadlessArgs } = await import("./args.ts");
    expect(parseHeadlessArgs(["-p", "hi", "--frobnicate"])).toMatchObject({ exitCode: 2 });
  });
});
