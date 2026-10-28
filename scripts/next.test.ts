// `bun run next` shows the owner's overrides that no session has applied yet (build loop step 3).
import { describe, expect, test } from "bun:test";
import { followupSection, sections, unappliedOverrides, urgentFollowups } from "./next.ts";

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
  test("lists open blocker and major follow-ups, blockers first, and leaves minor ones for later", () => {
    const out = urgentFollowups(
      followups(
        "### F2 (M2-01): path compare\n- **Severity:** major · `src/a.ts:3`\n\n### F3 (M2-02): wording\n- **Severity:** minor · `src/b.ts:9`\n\n### F4 (M2-03): leak\n- **Severity:** blocker · `src/c.ts:1`\n",
      ),
    );
    expect(out).toContain("### F2 (M2-01): path compare");
    expect(out).toContain("### F4 (M2-03): leak");
    expect(out.indexOf("F4")).toBeLessThan(out.indexOf("F2"));
    expect(out).not.toContain("F3");
  });

  test("a fixed follow-up is not listed", () => {
    expect(urgentFollowups(followups(""))).toBe("");
  });

  test("blockers come first, then the oldest, whatever order the file lists them in", () => {
    const out = urgentFollowups(
      followups(
        "### F9 (M2-09): newest major\n- **Severity:** major · `src/a.ts`\n\n### F7 (M2-07): newer blocker\n- **Severity:** blocker · `src/b.ts`\n\n### F3 (M2-03): oldest major\n- **Severity:** major · `src/c.ts`\n\n### F8 (M2-08): newest blocker\n- **Severity:** blocker · `src/d.ts`\n",
      ),
    );
    const order = [...out.matchAll(/^### (F\d+)/gm)].map((m) => m[1]);
    expect(order).toEqual(["F7", "F8", "F3", "F9"]);
  });
});

describe("followupSection", () => {
  test("prints the one to fix in full and only the ids and severities of the rest", () => {
    const out = followupSection(
      "### F7 (M2-07): blocker\n- **Severity:** blocker · `src/b.ts`\n- long body\n\n### F3 (M2-03): major\n- **Severity:** major · `src/c.ts`\n- another long body",
    );
    expect(out).toContain("- long body");
    expect(out).toContain("Also open, not this session's work: F3 (major)");
    expect(out).not.toContain("another long body");
    expect(out).not.toContain("src/c.ts");
  });

  test("entries on the chosen one's Class line are this session's work, not 'also open'", () => {
    const out = followupSection(
      "### F7 (M2-07): blocker\n- **Severity:** blocker · `src/b.ts`\n- **Class:** one cause (F3 F7 F9): spec §4.0\n\n### F3 (M2-03): major\n- **Severity:** major\n\n### F5 (M2-05): other\n- **Severity:** major\n\n### F9 (M2-09): blocker\n- **Severity:** blocker",
    );
    expect(out).toContain("Same cause, close them in this PR");
    expect(out).toMatch(/Same cause[^\n]*F3 \(major\), F9 \(blocker\)/);
    expect(out).toContain("Also open, not this session's work: F5 (major)");
    expect(out).not.toMatch(/Also open[^\n]*F3/);
    expect(out).not.toMatch(/Also open[^\n]*F9/);
  });

  test("a single follow-up has no 'also open' line, and none at all gives an empty section", () => {
    expect(followupSection("### F7 (M2-07): x\n- **Severity:** blocker")).not.toContain("Also open");
    expect(followupSection("")).toBe("");
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
