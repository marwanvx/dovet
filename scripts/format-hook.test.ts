import { describe, expect, test } from "bun:test";
import { writesFiles } from "../.claude/hooks/format.ts";

describe("format hook: which Bash commands write files", () => {
  test("the ways the agent edits through Bash count: heredocs, python, sed -i, redirects, tee, git apply", () => {
    for (const command of [
      "python3 - <<'EOF'\np='src/a.ts'\nEOF",
      "cd /repo && python3 -I -c \"open('a.ts','w').write('x')\"",
      "sed -i 's/a/b/' src/a.ts",
      "cat > src/a.ts <<'EOF'\nx\nEOF",
      "echo '{}' >> package.json",
      "printf x | tee src/a.ts",
      "git apply fix.patch",
    ])
      expect(writesFiles(command)).toBe(true);
  });

  test("reading, testing and git/gh queries do not", () => {
    for (const command of [
      "git status --short",
      "bun test scripts/ 2>&1 | tail -n 5",
      "grep -rn foo src | head -n 3",
      "sed -n 1,40p src/a.ts",
      "gh pr view 12 --json state",
      "ls -la > /dev/null",
      "bun run check 2>&1 | tail -n 20",
    ])
      expect(writesFiles(command)).toBe(false);
  });
});
