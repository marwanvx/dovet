// PreToolUse(Read): a whole spec file is refused; `bun run next` already printed the sections a task needs.
import { isAbsolute, join, normalize, relative } from "node:path";

type ReadInput = { file_path?: string; offset?: number; limit?: number };

export function specReadBlock(input: ReadInput, projectDir: string): string | undefined {
  const raw = input.file_path ?? "";
  const path = normalize(isAbsolute(raw) ? raw : join(projectDir, raw));
  const rel = relative(projectDir, path).split("\\").join("/");
  if (!/^docs\/specs\/[^/]+\.md$/.test(rel)) return undefined;
  if (input.offset !== undefined || input.limit !== undefined) return undefined;
  return `Whole-file reads of ${rel} are refused: \`bun run next\` printed the sections this task needs, each with its line range ("(${rel} lines A–B)"). Use that text, or Read this file again with offset and limit set to the lines you need.`;
}

if (import.meta.main) {
  const event = (await Bun.stdin.json()) as { tool_input?: ReadInput };
  const reason = specReadBlock(event.tool_input ?? {}, process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (reason !== undefined) {
    console.error(reason);
    process.exit(2);
  }
}
