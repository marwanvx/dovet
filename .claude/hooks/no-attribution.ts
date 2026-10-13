// PreToolUse(Bash): owner rule (AGENTS.md, 2026-10-13): no vendor attribution in commits, PRs or GitHub comments.
const input = (await Bun.stdin.json()) as { tool_input?: { command?: string } };
const command = input.tool_input?.command ?? "";
const publishes = /\bgit\b[^\n]*\bcommit\b|\bgh\s+(pr|issue)\s+(create|edit|comment|review)\b|\bgh\s+api\b/.test(command);
const attribution = /co-authored-by\s*:|generated with|claude\.ai\/code|claude\.com\/claude-code|noreply@anthropic\.com/i;
import { readFileSync } from "node:fs";

// `git commit -F msg.txt` and `gh pr create --body-file body.md` carry the text in a file.
const files = [...command.matchAll(/(?:^|\s)(?:-F|--file|--body-file)[=\s]+("[^"]+"|'[^']+'|\S+)/g)].map((m) =>
  (m[1] ?? "").replace(/^["']|["']$/g, ""),
);
const fileText = files
  .map((f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");
if (publishes && (attribution.test(command) || attribution.test(fileText))) {
  console.error(
    "Blocked by the owner rule in AGENTS.md: no vendor attribution (Co-Authored-By trailers, 'Generated with' lines, session links) in commits, PRs or GitHub comments. Remove it and run the command again.",
  );
  process.exit(2);
}
