// `bun run next` shows the owner's overrides that no session has applied yet (build loop step 3).
import { describe, expect, test } from "bun:test";
import { sections, unappliedOverrides, urgentFollowups } from "./next.ts";

const file = (answered: string) => `# Questions\n\n## Waiting for the owner\n\n(none)\n\n## Answered\n\n${answered}`;

describe("unappliedOverrides", () => {
  test("lists an answered question the owner overrode and nobody applied yet", () => {
    const out = unappliedOverrides(
      file(
        "### Q1 (M0-01): A\n- **Answer (agent, 2026-10-12):** yes\n\n### Q2 (M0-04): B\n- **Answer (agent, 2026-10-12):** no\n- **Override (owner, 2026-10-13):** do the other thing\n",
      ),
    );
    expect(out).toContain("### Q2 (M0-04): B");
    expect(out).toContain("do the other thing");
    expect(out).not.toContain("Q1");
  });

  test("does not list an override that was already applied", () => {
    const out = unappliedOverrides(
      file("### Q2 (M0-04): B\n- **Override (owner, 2026-10-13):** x\n- **Override applied:** spec changed in #12\n"),
    );
    expect(out).toBe("");
  });

  test("an override-looking line above the Answered section is ignored", () => {
    expect(unappliedOverrides("## Waiting for the owner\n### Q9\n- **Override (owner, d):** x\n\n## Answered\n")).toBe(
      "",
    );
  });
});

const followups = (open: string) =>
  `# Follow-ups\n\n## Open\n\n${open}\n## Fixed\n\n### F1 (M1-02): old\n- **Severity:** blocker\n`;

describe("urgentFollowups", () => {
  test("lists open blocker and major follow-ups, oldest first, and leaves minor ones for later", () => {
    const out = urgentFollowups(
      followups(
        "### F2 (M2-01): path compare\n- **Severity:** major · `src/a.ts:3`\n\n### F3 (M2-02): wording\n- **Severity:** minor · `src/b.ts:9`\n\n### F4 (M2-03): leak\n- **Severity:** blocker · `src/c.ts:1`\n",
      ),
    );
    expect(out).toContain("### F2 (M2-01): path compare");
    expect(out).toContain("### F4 (M2-03): leak");
    expect(out.indexOf("F2")).toBeLessThan(out.indexOf("F4"));
    expect(out).not.toContain("F3");
  });

  test("a fixed follow-up is not listed", () => {
    expect(urgentFollowups(followups(""))).toBe("");
  });
});

describe("sections", () => {
  test("each printed section names its exact line range, so an agent can read just those lines", () => {
    const doc = "# Spec\n\nintro\n\n## 1. One\na\nb\n\n## 2. Two\nc\n\n### 2.1 Sub\nd\n\n## 3. Three\ne\n";
    expect(sections(doc, ["2"]).map((s) => [s.from, s.to, s.text.split("\n")[0]])).toEqual([[9, 13, "## 2. Two"]]);
    expect(sections(doc, ["1", "Three"]).map((s) => [s.from, s.to])).toEqual([
      [5, 7],
      [15, 16],
    ]);
  });
});
