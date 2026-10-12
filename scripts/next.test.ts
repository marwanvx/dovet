// `bun run next` shows the owner's overrides that no session has applied yet (build loop step 3).
import { describe, expect, test } from "bun:test";
import { unappliedOverrides } from "./next.ts";

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
