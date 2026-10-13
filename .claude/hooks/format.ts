// PostToolUse(Edit|Write): format and lint-fix the edited file with Biome, so `bun run check` doesn't fail on style.
import { relative } from "node:path";

const input = (await Bun.stdin.json()) as { tool_input?: { file_path?: string }; cwd?: string };
const file = input.tool_input?.file_path;
if (file === undefined || !/\.(ts|tsx|js|json|jsonc)$/.test(file)) process.exit(0);
const root = input.cwd ?? process.cwd();
const rel = relative(root, file);
if (rel.startsWith("..")) process.exit(0);
const proc = Bun.spawn(["bunx", "biome", "check", "--write", "--no-errors-on-unmatched", rel], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
const [out, err, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
// Exit 2 shows Biome's remaining (unfixable) findings to the model; the edit itself already happened.
if (code !== 0) {
  console.error(`${out}${err}`.trim());
  process.exit(2);
}
