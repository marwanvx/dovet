// Built-and-tested code that nothing in the product calls was 15 of ~51 bugs that escaped review (M1-24…M2-04).
import { describe, expect, test } from "bun:test";
import { unwiredExports, wiringProblems } from "./wiring.ts";

const files = [
  { path: "src/a/wired.ts", text: "export function used() {}\nexport const unused = 1;\n" },
  { path: "src/a/caller.ts", text: 'import { used } from "./wired.ts";\nused();\n' },
  { path: "src/a/index.ts", text: 'export { unused } from "./wired.ts";\n' },
  { path: "src/a/wired.test.ts", text: 'import { unused } from "./wired.ts";\nunused;\n' },
  { path: "scripts/gen.ts", text: 'import { forScripts } from "../src/b.ts";\nforScripts();\n' },
  { path: "src/b.ts", text: "export async function forScripts() {}\n" },
];

describe("unwiredExports", () => {
  test("an export only tests and index re-exports mention is unwired; a script caller counts as wired", () => {
    expect(unwiredExports(files)).toEqual(["src/a/wired.ts:unused"]);
  });
});

describe("wiringProblems", () => {
  const status = (owner: string) => (owner === "M2-05" ? "open" : owner === "M1-25" ? "done" : "unknown");
  test("an unwired export needs a ledger owner; an open owner passes; a done owner fails", () => {
    expect(wiringProblems(["x.ts:a"], {}, status)).toEqual([
      'x.ts:a is called only by tests: add it to scripts/wiring.json with the task that will wire it, or "test-only: <why>"',
    ]);
    expect(wiringProblems(["x.ts:a"], { "x.ts:a": "M2-05" }, status)).toEqual([]);
    expect(wiringProblems(["x.ts:a"], { "x.ts:a": "M1-25" }, status)).toEqual([
      "x.ts:a: M1-25 is done but nothing outside tests calls it yet",
    ]);
    expect(wiringProblems(["x.ts:a"], { "x.ts:a": "test-only: a fixture builder" }, status)).toEqual([]);
  });

  test("a ledger entry whose export is now wired, or names an unknown owner, is reported", () => {
    expect(wiringProblems([], { "x.ts:a": "M2-05" }, status)).toEqual([
      "x.ts:a is wired now: remove it from scripts/wiring.json",
    ]);
    expect(wiringProblems(["x.ts:a"], { "x.ts:a": "M9-99" }, status)).toEqual([
      "x.ts:a: owner M9-99 is not a task or follow-up id",
    ]);
  });
});
