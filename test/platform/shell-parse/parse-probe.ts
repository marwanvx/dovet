// Built by shell-parse.test.ts with Dovet's own compile options (scripts/build.ts) to show the embedded
// tree-sitter grammars load inside a compiled binary. Reads `{ bash: string[], powershell: string[] }` as JSON on
// stdin and prints, per command, the root node type, whether the tree has an error, and its S-expression.
import { loadShellParsers } from "../../../src/policy/index.ts";

type Sample = { bash: string[]; powershell: string[] };
const input = JSON.parse(await Bun.stdin.text()) as Sample;
const parsers = await loadShellParsers();
const out = {
  abi: parsers.abi,
  bash: input.bash.map((cmd) => parsers.parse("bash", cmd)),
  powershell: input.powershell.map((cmd) => parsers.parse("powershell", cmd)),
};
process.stdout.write(`${JSON.stringify(out)}\n`);
