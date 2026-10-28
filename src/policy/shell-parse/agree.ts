// The four checks of permissions §4.0 item 9: places where tree-sitter-bash and bash read the same text differently.
import type { Node } from "web-tree-sitter";

const WORDS = new Set([
  ...["word", "string", "raw_string", "ansi_c_string", "translated_string", "concatenation", "number"],
  ...["simple_expansion", "expansion", "command_substitution", "process_substitution", "arithmetic_expansion"],
  ...["command_name", "variable_assignment", "file_redirect", "herestring_redirect"],
]);
const JOINED = new Set(["concatenation", "string", "translated_string", "heredoc_body"]);
const SUBSTITUTIONS = new Set(["command_substitution", "process_substitution"]);

const isBacktick = (n: Node): boolean => n.type === "command_substitution" && n.text.startsWith("`");

/** Every node outside a backtick body (read again from its own text), and whether it is inside a here-document body. */
function* outer(root: Node): Generator<[Node, boolean]> {
  const todo: [Node, boolean][] = [[root, false]];
  for (let e = todo.pop(); e !== undefined; e = todo.pop()) {
    yield e;
    const [n, body] = e;
    if (!isBacktick(n)) for (const c of n.children) todo.push([c, body || n.type === "heredoc_body"]);
  }
}

type Mode = "code" | "dq" | "brace" | "braceDq" | "arith" | "bracket";
const BOUNDARY = /[\s;&|()<>]/;

/** Where bash starts a `$(`, backtick, `<(` or `>(` substitution, and where each `${…}` starts and ends, in `text`,
 * skipping `skip` (here-document bodies, whose substitutions the walker reads from the tree). Errs toward finding more: an extra one only makes the analysis unparsed. */
export function substitutionStarts(text: string, skip: [number, number][]): { starts: number[]; braces: string[] } {
  const starts: number[] = [];
  const braces: string[] = [];
  const stack: { mode: Mode; depth: number; at?: number }[] = [{ mode: "code", depth: 0 }];
  const closeBacktick = (from: number): number => {
    for (let j = from; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "`") return j;
    }
    return text.length;
  };
  for (let i = 0; i < text.length; i++) {
    const s = skip.find(([a, b]) => a <= i && i < b);
    if (s) {
      i = s[1] - 1;
      continue;
    }
    const top = stack[stack.length - 1] ?? { mode: "code", depth: 0 };
    const c = text[i];
    const next = text[i + 1];
    const quoted = top.mode === "dq" || top.mode === "braceDq";
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      starts.push(i);
      i = closeBacktick(i + 1);
      continue;
    }
    if (c === "$" && next === "(" && text[i + 2] === "(") {
      stack.push({ mode: "arith", depth: 0 });
      i += 2;
      continue;
    }
    if (c === "$" && next === "(") {
      starts.push(i);
      stack.push({ mode: "code", depth: 0 });
      i++;
      continue;
    }
    if (c === "$" && next === "[") {
      stack.push({ mode: "bracket", depth: 0 });
      i++;
      continue;
    }
    if (c === "$" && next === "{") {
      stack.push({ mode: quoted ? "braceDq" : "brace", depth: 0, at: i });
      i++;
      continue;
    }
    if (c === '"' && top.mode === "dq") {
      stack.pop();
      continue;
    }
    if (c === '"') {
      stack.push({ mode: "dq", depth: 0 });
      continue;
    }
    if (quoted && top.mode === "dq") continue;
    if (c === "}" && (top.mode === "brace" || top.mode === "braceDq")) {
      braces.push(`${top.at}-${i + 1}`);
      stack.pop();
      continue;
    }
    if (top.mode === "braceDq") continue;
    if (c === "'" && top.mode !== "arith" && top.mode !== "bracket") {
      if (text[i - 1] === "$") {
        for (i++; i < text.length && text[i] !== "'"; i++) if (text[i] === "\\") i++;
      } else {
        const end = text.indexOf("'", i + 1);
        i = end < 0 ? text.length : end;
      }
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") {
      starts.push(i);
      stack.push({ mode: "code", depth: 0 });
      i++;
      continue;
    }
    if (top.mode === "bracket") {
      if (c === "[") top.depth++;
      else if (c === "]" && top.depth-- === 0) stack.pop();
      continue;
    }
    if (c === "(") top.depth++;
    else if (c === ")" && top.mode === "arith" && top.depth === 0 && next === ")") {
      stack.pop();
      i++;
    } else if (c === ")" && top.depth === 0 && stack.length > 1 && top.mode === "code") stack.pop();
    else if (c === ")") top.depth--;
    else if (c === "#" && top.mode === "code" && (i === 0 || BOUNDARY.test(text[i - 1] ?? ""))) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end - 1;
    }
  }
  return { starts, braces };
}

/** Why the tree and the text disagree (permissions §4.0 item 9), or undefined. `walked` holds the ids of the command
 * and backtick nodes the walker read. */
export function disagreement(root: Node, text: string, walked: Set<number>): string | undefined {
  const bodies: [number, number][] = [];
  const nodes = new Set<number>();
  const expansions = new Set<string>();
  for (const [n, inBody] of outer(root)) {
    if (n.type === "heredoc_body" && !inBody) bodies.push([n.startIndex, n.endIndex]);
    if (SUBSTITUTIONS.has(n.type) && !inBody) nodes.add(n.startIndex);
    if (n.type === "expansion" && !inBody) expansions.add(`${n.startIndex}-${n.endIndex}`);
    if ((n.type === "command" || isBacktick(n)) && !walked.has(n.id)) return "a command the walker never read";
    if (n.type === "word" && /^\s/.test(n.text)) return "text between the words of one command";
    // bash ends a here-document only at a line that is its delimiter alone (`<<-` strips leading tabs).
    if (
      n.type === "heredoc_end" &&
      !(/(^|\n)\t*$/.test(text.slice(0, n.startIndex)) && /^(\n|$)/.test(text.slice(n.endIndex)))
    )
      return "a here-document end that isn't a whole line";
    const kids = n.children;
    for (let k = 1; k < kids.length; k++) {
      const [a, b] = [kids[k - 1], kids[k]];
      if (a === undefined || b === undefined) continue;
      // The grammar skips an escaped blank as if it were a separator (`a=\  cat`, `printf x \  a`).
      if (text.slice(a.endIndex, b.startIndex).includes("\\")) return "text between the words of one command";
      if (n.type === "command" && (a.type === "comment" || !/^[ \t]*$/.test(text.slice(a.endIndex, b.startIndex))))
        return "text between the words of one command";
      if (!JOINED.has(n.type) && a.endIndex === b.startIndex && WORDS.has(a.type) && WORDS.has(b.type))
        if (!b.type.endsWith("redirect")) return "one word split in two";
    }
  }
  const { starts, braces } = substitutionStarts(text, bodies);
  if (starts.length !== nodes.size || starts.some((s) => !nodes.has(s))) return "a substitution the tree doesn't hold";
  if (braces.length !== expansions.size || braces.some((b) => !expansions.has(b)))
    return "a ${…} that ends elsewhere in bash";
  return undefined;
}
