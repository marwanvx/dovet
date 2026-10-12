// The criterion-to-test check (docs/specs/testing.md "Coverage targets"), run on small inputs.
import { describe, expect, test } from "bun:test";
import { coverageProblems, tagsIn } from "./spec-coverage.ts";

const known = new Set(["AC-TOOLS-01", "AC-TOOLS-02", "AC-ARCH-04"]);

describe("spec coverage", () => {
  test("reads every criterion ID from `// spec:` tags, one or several per tag", () => {
    // Built from pieces so this file's own text holds no tag.
    const tag = ["/", "/ spec:"].join("");
    const text = `test("a", () => {}); ${tag} AC-TOOLS-01\n  ${tag} AC-TOOLS-02, AC-ARCH-04\n// AC-TOOLS-09 is not a tag\n`;
    expect([...tagsIn(text)].sort()).toEqual(["AC-ARCH-04", "AC-TOOLS-01", "AC-TOOLS-02"]);
  });

  test("a tag naming an unknown criterion is a problem, with the file it is in", () => {
    const problems = coverageProblems({
      known,
      done: [],
      tags: new Map([["src/tools/read.test.ts", new Set(["AC-TOOLS-99"])]]),
    });
    expect(problems).toEqual(["unknown criterion in a test tag: AC-TOOLS-99 (src/tools/read.test.ts)"]);
  });

  test("a criterion of a done task without a tagged test is a problem", () => {
    const problems = coverageProblems({
      known,
      done: [{ task: "M1-04", criteria: ["AC-TOOLS-01", "AC-TOOLS-02"] }],
      tags: new Map([["src/tools/read.test.ts", new Set(["AC-TOOLS-01"])]]),
    });
    expect(problems).toEqual(["criterion of done task M1-04 has no tagged test: AC-TOOLS-02"]);
  });

  test("criteria of tasks not done yet are not required", () => {
    expect(coverageProblems({ known, done: [], tags: new Map() })).toEqual([]);
  });
});
