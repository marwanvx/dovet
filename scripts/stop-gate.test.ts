import { describe, expect, test } from "bun:test";
import { blockReason, changedCode } from "../.claude/hooks/stop-gate.ts";

describe("stop gate", () => {
  test("only changed code files trigger the checks", () => {
    expect(changedCode(" M src/a.ts\n?? docs/x.md\nM  package.json\n")).toEqual(["src/a.ts", "package.json"]);
    expect(changedCode(" M docs/plan/tasks/PROGRESS.md\n")).toEqual([]);
  });

  test("passing checks let the session finish; a failure blocks with its output", () => {
    expect(blockReason([{ name: "tsc -b", code: 0, output: "" }])).toBeUndefined();
    const reason = blockReason([
      { name: "tsc -b", code: 2, output: "src/a.ts(3,1): error TS2322: Type 'string' is not assignable" },
      { name: "biome check .", code: 0, output: "" },
    ]);
    expect(reason).toContain("tsc -b fail");
    expect(reason).toContain("TS2322");
    expect(reason).not.toContain("biome");
  });
});
