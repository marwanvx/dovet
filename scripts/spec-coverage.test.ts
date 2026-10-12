// The criterion-to-test check (docs/specs/testing.md "Coverage targets"), run on small inputs.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { coverageProblems, repoInput, tagsIn } from "./spec-coverage.ts";

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

describe("spec coverage on a repository tree", () => {
  const tag = ["/", "/ spec:"].join("");
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function repo(status: string, tests: Record<string, string>): string[] {
    dir = mkdtempSync(join(tmpdir(), "dovet-coverage-"));
    const files: Record<string, string> = {
      "AGENTS.md": "# Agents\n",
      "docs/specs/demo.md": "# Demo\n\n- [ ] **AC-DEMO-01** one\n- [ ] **AC-DEMO-02** two\n",
      "docs/plan/tasks/M0.md": `# M0\n\n### M0-01 Demo\n- **Status:** ${status}\n- **Depends on:** —\n- **Done when:** AC-DEMO-01 and AC-DEMO-02 pass.\n`,
      ...tests,
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return coverageProblems(repoInput(dir));
  }

  test("a done task whose criterion has no tagged test fails", () => {
    expect(repo("done (#1)", { "src/demo/a.test.ts": `${tag} AC-DEMO-01\n` })).toEqual([
      "criterion of done task M0-01 has no tagged test: AC-DEMO-02",
    ]);
  });

  test("a tag naming several criteria covers each of them", () => {
    expect(repo("done (#1)", { "test/integration/a.test.ts": `${tag} AC-DEMO-01, AC-DEMO-02\n` })).toEqual([]);
  });

  test("tags in src/, test/ and scripts/ test files all count", () => {
    expect(
      repo("done (#1)", { "src/demo/a.test.ts": `${tag} AC-DEMO-01\n`, "scripts/b.test.ts": `${tag} AC-DEMO-02\n` }),
    ).toEqual([]);
    expect(repo("done (#1)", { "scripts/b.test.ts": `${tag} AC-DEMO-02\n` })).toEqual([
      "criterion of done task M0-01 has no tagged test: AC-DEMO-01",
    ]);
  });

  test("a tag in a file that is not a test does not count", () => {
    expect(repo("done (#1)", { "src/demo/a.ts": `${tag} AC-DEMO-01, AC-DEMO-02\n` })).toHaveLength(2);
  });

  test("a task that is not done yet needs no tests", () => {
    expect(repo("in-progress", {})).toEqual([]);
  });
});
