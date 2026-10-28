import { describe, expect, test } from "bun:test";
import { runSteps, STEPS, summary } from "./check.ts";

describe("runSteps", () => {
  test("runs every step in order even after one fails, so a failing step hides none of the others", async () => {
    const seen: string[] = [];
    const results = await runSteps(
      [
        { name: "types", cmd: ["a"] },
        { name: "test", cmd: ["b"] },
        { name: "docs:check", cmd: ["c"] },
      ],
      async (cmd) => {
        seen.push(cmd[0] ?? "");
        return cmd[0] === "b" ? 1 : 0;
      },
    );
    expect(seen).toEqual(["a", "b", "c"]);
    expect(results.map((r) => [r.name, r.code])).toEqual([
      ["types", 0],
      ["test", 1],
      ["docs:check", 0],
    ]);
  });
});

describe("summary", () => {
  test("names every step with its result and says which failed", () => {
    const text = summary([
      { name: "types", code: 0, seconds: 3 },
      { name: "test", code: 1, seconds: 95 },
      { name: "wiring", code: 0, seconds: 1 },
    ]);
    expect(text).toContain("PASS  types");
    expect(text).toContain("FAIL  test");
    expect(text).toContain("PASS  wiring");
    expect(text).toContain("1 of 3 steps failed: test");
  });

  test("all passing says so", () => {
    expect(summary([{ name: "types", code: 0, seconds: 1 }])).toContain("all 1 steps passed");
  });
});

describe("STEPS", () => {
  test("is the gate package.json used to chain: types, lint, dependency direction, tests, coverage, docs, wiring", () => {
    expect(STEPS.map((s) => s.name)).toEqual([
      "types",
      "lint",
      "lint:deps",
      "test",
      "spec:coverage",
      "docs:check",
      "wiring",
    ]);
  });
});
