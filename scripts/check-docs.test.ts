// `bun run docs:check` fails when an answered question doesn't say which spec holds its answer (build loop step 6).
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answersWithoutSpec, instructionText, overBudget } from "./check-docs.ts";

const file = (answered: string) =>
  `# Questions\n\n## Waiting for the owner\n\n### W1 (M0-09): a key\n- no spec line needed here\n\n## Answered\n\n${answered}`;

describe("answersWithoutSpec", () => {
  test("names an answered question that has no Spec line", () => {
    const out = answersWithoutSpec(
      file(
        "### Q1 (M0-01): A\n- **Answer:** yes\n- **Spec:** tools §1.\n\n### Q2 (M0-04): B\n- **Answer:** no\n\n### Q3 (M1-01): C\n- **Answer:** x\n- **Spec:** none: plan only.\n",
      ),
    );
    expect(out).toEqual(["Q2"]);
  });

  test("a Spec line inside another field doesn't count", () => {
    expect(answersWithoutSpec(file("### Q4 (M1-02): D\n- **Answer:** see the **Spec:** later\n"))).toEqual(["Q4"]);
  });

  test("entries waiting for the owner need no Spec line", () => {
    expect(answersWithoutSpec(file(""))).toEqual([]);
  });
});

describe("overBudget", () => {
  test("names a context source that grew past its token ceiling, and nothing under it", () => {
    const out = overBudget(
      { "instruction files": 8000, "bun run next M1-23c": 14000 },
      { "instruction files": 7500, "bun run next": 15000 },
    );
    expect(out).toEqual(["instruction files: about 8000 tokens, over its ceiling of 7500"]);
  });

  test("a per-task next output is checked against the shared next ceiling", () => {
    expect(overBudget({ "bun run next M2-05": 16000 }, { "bun run next": 15000 })).toEqual([
      "bun run next M2-05: about 16000 tokens, over its ceiling of 15000",
    ]);
  });
});

describe("instructionText", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });

  test("a skip-worktree file counts as what git holds, so a local run measures what CI measures; any other file as it is on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "dovet-instr-"));
    try {
      mkdirSync(join(dir, "docs"));
      git(dir, "init", "-q");
      writeFileSync(join(dir, "AGENTS.md"), "committed wording");
      writeFileSync(join(dir, "docs", "plain.md"), "committed");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "x");
      git(dir, "update-index", "--skip-worktree", "AGENTS.md");
      writeFileSync(join(dir, "AGENTS.md"), "a much longer local variant of the file");
      writeFileSync(join(dir, "docs", "plain.md"), "edited on disk, not committed");
      expect(instructionText(dir, "AGENTS.md")).toBe("committed wording");
      expect(instructionText(dir, "docs/plain.md")).toBe("edited on disk, not committed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("outside a git checkout (a source archive) the file on disk is all there is", () => {
    const dir = mkdtempSync(join(tmpdir(), "dovet-instr-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "just a file");
      expect(instructionText(dir, "AGENTS.md")).toBe("just a file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
