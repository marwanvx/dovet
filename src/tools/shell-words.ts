// A conservative reader for the shapes of bash command the Bash tool treats specially (tools §5.6, 5.9, 5.11). Anything it can't read exactly yields undefined.
export type Simple = {
  words: string[];
  piped: boolean;
  redirected: boolean;
  /** A word contains an expansion or glob, so its value isn't known before running. */
  dynamic: boolean;
};

const SEPARATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n"];

export function simpleCommands(command: string): Simple[] | undefined {
  const out: Simple[] = [];
  let cur: Simple = { words: [], piped: false, redirected: false, dynamic: false };
  let word: string | undefined;
  const endWord = (): void => {
    if (word !== undefined) cur.words.push(word);
    word = undefined;
  };
  const endCommand = (piped: boolean): void => {
    endWord();
    if (cur.words.length > 0 || cur.redirected) out.push(cur);
    cur = { words: [], piped, redirected: false, dynamic: false };
  };
  for (let i = 0; i < command.length; ) {
    const c = command.charAt(i);
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      for (; j < command.length && command.charAt(j) !== '"'; j++) {
        const d = command.charAt(j);
        if (d === "\\" && j + 1 < command.length) {
          j++;
          text += command.charAt(j);
        } else {
          if (d === "$" || d === "`") cur.dynamic = true;
          text += d;
        }
      }
      if (j >= command.length) return undefined;
      word = (word ?? "") + text;
      i = j + 1;
    } else if (c === "\\") {
      if (i + 1 >= command.length) return undefined;
      if (command.charAt(i + 1) === "\n") {
        i += 2;
        continue;
      }
      word = (word ?? "") + command.charAt(i + 1);
      i += 2;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "#" && word === undefined) {
      const nl = command.indexOf("\n", i);
      i = nl < 0 ? command.length : nl;
    } else {
      const sep = SEPARATORS.find((s) => command.startsWith(s, i));
      if (sep !== undefined) {
        endCommand(sep === "|" || sep === "|&");
        i += sep.length;
      } else if (c === "<" || c === ">") {
        if (command.startsWith("<<", i)) return undefined;
        // `2>` and `&>` carry their descriptor in the word just read.
        if (word !== undefined && /^\d+$/.test(word)) word = undefined;
        endWord();
        cur.redirected = true;
        i++;
      } else if ("(){}".includes(c)) {
        return undefined;
      } else {
        if (c === "$" || c === "`" || c === "*" || c === "?" || c === "[" || c === "~") cur.dynamic = true;
        word = (word ?? "") + c;
        i++;
      }
    }
  }
  endCommand(false);
  return out;
}

const isAssignment = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** The program a command runs and its arguments, after leading `VAR=value` words. */
export function programOf(s: Simple): { program: string; args: string[] } | undefined {
  const i = s.words.findIndex((w) => !isAssignment(w));
  const program = s.words[i];
  if (program === undefined) return undefined;
  return { program: program.split("/").pop() ?? program, args: s.words.slice(i + 1) };
}

export function gitSubcommand(args: readonly string[]): { sub: string; rest: string[] } | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") i++;
    else if (!a.startsWith("-")) return { sub: a, rest: args.slice(i + 1) };
  }
  return undefined;
}
