// `bun run docs:check` fails when an answered question doesn't say which spec holds its answer (build loop step 6).
import { describe, expect, test } from "bun:test";
import { answersWithoutSpec, overBudget } from "./check-docs.ts";

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
