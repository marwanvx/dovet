// PreToolUse(Read): whole spec files are refused, a line range is allowed (workflow audit: spec reads were 30% of context).
import { describe, expect, test } from "bun:test";
import { specReadBlock } from "../.claude/hooks/spec-reads.ts";

const root = "/repo";

describe("spec read guard", () => {
  test("a whole-file read of a spec is refused with the way out", () => {
    const reason = specReadBlock({ file_path: "/repo/docs/specs/permissions.md" }, root);
    expect(reason).toContain("bun run next");
    expect(reason).toContain("offset");
  });

  test("a read with a line range, or of any other file, is allowed", () => {
    expect(
      specReadBlock({ file_path: "/repo/docs/specs/permissions.md", offset: 427, limit: 40 }, root),
    ).toBeUndefined();
    expect(specReadBlock({ file_path: "/repo/docs/specs/tools.md", limit: 60 }, root)).toBeUndefined();
    expect(specReadBlock({ file_path: "/repo/src/agent/loop.ts" }, root)).toBeUndefined();
    expect(specReadBlock({ file_path: "/repo/docs/plan/tasks/M2.md" }, root)).toBeUndefined();
  });

  test("a spec reached through another spelling of the path is still a spec", () => {
    expect(specReadBlock({ file_path: "/repo/src/../docs/specs/tui.md" }, root)).toBeDefined();
    expect(specReadBlock({ file_path: "docs/specs/tui.md" }, root)).toBeDefined();
  });
});
