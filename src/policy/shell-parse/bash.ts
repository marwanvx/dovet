// Walks a bash syntax tree: finds every simple command and fails closed on anything off the allowlist (permissions §4.0).
import type { Node } from "web-tree-sitter";
import {
  commandName,
  isSafeEnv,
  type Redirect,
  type Subcommand,
  shellScriptAt,
  unwrapCommand,
  xargsCommandStarts,
} from "../rules/index.ts";
import type { Context } from "./context.ts";
import { classify, literalTexts, textOnly, type Word } from "./read-only.ts";

export type State = { cwd: string; stack: string[]; loops: Map<string, string[]>; depth: number };

export type Walk = {
  ctx: Context;
  /** Parses and walks a script from `sh -c`; false when it could not be parsed. */
  script(text: string, st: State): boolean;
};

const MAX_DEPTH = 8;
const CWD_DEFAULT = new Set(["find", "ls", "tree", "du", "rg", "fd", "fdfind", "grep"]);
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// They run a string as commands: a trap's action, a script in another shell's language (`pwsh -EncodedCommand`
// can't be read at all), or a program in WSL or through cmd's `start`.
const NEVER_UNDERSTOOD = new Set([
  ...["eval", "source", ".", "exec", "coproc", "trap", "wsl", "start"],
  ...["pwsh", "pwsh-preview", "powershell", "powershell_ise", "fish", "tcsh", "csh", "mksh", "ash"],
]);
const REDIRECTS = new Set(["file_redirect", "heredoc_redirect", "herestring_redirect"]);
const RESERVED = new Set([
  ...["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "select", "case", "esac", "in"],
  ...["function", "!", "[[", "]]"],
]);
const STATEMENTS = new Set([
  ...["subshell", "compound_statement", "if_statement", "while_statement", "for_statement", "case_statement"],
  ...["c_style_for_statement", "function_definition", "pipeline", "list", "negated_command", "test_command"],
]);

const VERBATIM = new Set(["raw_string", "ansi_c_string", "comment"]);

/** Single quotes, `$'…'`, comments and quoted here-document bodies: where bash keeps a `\<newline>` as written.
 * Not inside backticks: bash removes every `\<newline>` from a backtick body before it parses it. */
export function verbatimRanges(root: Node): [number, number][] {
  const kept: [number, number][] = [];
  const todo = [root];
  for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
    if (n.type === "command_substitution" && n.text.startsWith("`")) continue;
    if (VERBATIM.has(n.type)) kept.push([n.startIndex, n.endIndex]);
    else if (
      n.type === "heredoc_redirect" &&
      /['"\\]/.test(n.namedChildren.find((c) => c.type === "heredoc_start")?.text ?? "")
    )
      for (const b of n.namedChildren) if (b.type === "heredoc_body") kept.push([b.startIndex, b.endIndex]);
    todo.push(...n.children);
  }
  return kept.sort((a, b) => a[0] - b[0]);
}

/** The text bash's lexer reads (QUESTIONS Q102): every unquoted `\<newline>` outside `kept` removed. `removed` holds
 * where each one was, as offsets in the joined text; `crlf` is a `\<CR><LF>`, which bash doesn't join and the grammar does. */
export function joinContinuations(
  text: string,
  kept: [number, number][],
): { text: string; removed: number[]; crlf: boolean } {
  const removed: number[] = [];
  let crlf = false;
  let out = "";
  let r = 0;
  for (let i = 0; i < text.length; i++) {
    while ((kept[r]?.[1] ?? Infinity) <= i) r++;
    const [start, end] = kept[r] ?? [Infinity, Infinity];
    if (start <= i) {
      out += text.slice(i, end);
      i = end - 1;
    } else if (text[i] !== "\\" || i + 1 === start) out += text[i];
    else if (text[i + 1] === "\n") {
      removed.push(out.length);
      i++;
    } else {
      if (text[i + 1] === "\r" && text[i + 2] === "\n") crlf = true;
      out += text.slice(i, i + 2);
      i++;
    }
  }
  return { text: out, removed, crlf };
}

/** The `…` substitutions of an unquoted here-document body; `\`` there is a literal backtick. */
function backticks(body: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") i++;
    else if (body[i] === "`" && start < 0) start = i + 1;
    else if (body[i] === "`") {
      out.push(body.slice(start, i));
      start = -1;
    }
  }
  return start < 0 ? out : [...out, body.slice(start)];
}

/** A backtick substitution's body, or undefined when its first unescaped closing backtick isn't where the grammar ends it
 * (no input seen so far does that without a parse error too: a second guard). */
function backtickBody(text: string): string | undefined {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return i === text.length - 1 ? text.slice(1, i) : undefined;
  }
  return undefined;
}

/** bash removes the backslash of `\\`, `\``, `\$` (and `\"` inside double quotes) in a backtick body, then parses it. */
const unescapeBackticks = (body: string, quoted: boolean): string =>
  body.replace(quoted ? /\\([\\`$"])/g : /\\([\\`$])/g, "$1");

/** Whether `\"` loses its backslash: directly inside one quoted word, yes; under a construct or a second string inside
 * one, bash's answer depends on the construct (`"$[ ]"` yes, `"$(( ))"` and `"${x:-"…"}"` no), so undefined. */
function inQuotes(n: Node): boolean | undefined {
  let strings = 0;
  for (let p = n.parent; p !== null && p.type !== "command_substitution"; p = p.parent)
    if (p.type === "string") strings++;
  if (strings === 0) return false;
  return strings === 1 && n.parent?.type === "string" ? true : undefined;
}

/** tree-sitter-bash reads a compound command after `coproc`, `time` or `!` as simple commands with no parse error
 * (`then git push`, `{ {` as one word): the reading isn't bash's. */
const misread = (n: Node): boolean => {
  const name = n.namedChildren.find((c) => c.type === "command_name")?.text;
  return (
    (name !== undefined && (RESERVED.has(name) || /^[{}\s]+$/.test(name))) ||
    n.namedChildren.some((c) => STATEMENTS.has(c.type))
  );
};

const fresh = (st: State): State => ({ ...st, stack: [...st.stack], loops: new Map(st.loops), depth: st.depth + 1 });

function hasUnescaped(raw: string, chars: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i);
    if (c === "\\") i++;
    else if (chars.includes(c)) return true;
  }
  return false;
}

const unbackslash = (raw: string): string => raw.replace(/\\\n/g, "").replace(/\\(.)/gs, "$1");
const unescapeQuoted = (raw: string): string => raw.replace(/\\\n/g, "").replace(/\\(["$`\\])/g, "$1");
const opaque = (n: Node): Word => ({ text: n.text, literal: false, glob: false });

/** Walks the tree; returns the ids of the command and backtick nodes it read. */
export function walkBash(root: Node, walk: Walk, st: State): Set<number> {
  const { ctx } = walk;
  const walked = new Set<number>();

  function loopWord(n: Node, st: State): Word | undefined {
    const ref = n.type === "string" ? n.namedChildren : [n];
    const only = ref.length === 1 ? ref[0] : undefined;
    if (only?.type !== "simple_expansion" || (n.type === "string" && n.text !== `"${only.text}"`)) return undefined;
    const values = st.loops.get(only.text.slice(1));
    if (values === undefined) return undefined;
    // A value that could be an option, split into words or expanded again is not a plain file name.
    if (!values.every((v) => /^[^\s*?[{~$`\\'"-][^\s*?[{$`\\'"]*$/.test(v)))
      return n.type === "string" ? opaque(n) : { ...opaque(n), split: true };
    return { text: n.text, literal: true, glob: false, values };
  }

  /** Reads the call as if every computed word were one plain word (F52): one where the command takes a file, inside
   * an option or split into words where they could be either is not checkable; the literal files beside one still get
   * the read check. */
  function computedRead(head: string, args: Word[], cwd: string): void {
    if (args.every((a) => a.literal)) return;
    const computed = new Set<Word>();
    const plain = args.map((a) => {
      if (a.literal) return a;
      const w: Word = { text: a.text, literal: true, glob: false };
      computed.add(w);
      return w;
    });
    const read = classify(head, plain);
    const split = args.some((a) => a.split === true);
    if (split && !(read.ok && textOnly(head))) ctx.fail("an unquoted substitution splits into any words");
    if (!read.ok) {
      if (plain.some((w) => computed.has(w) && w.text.startsWith("-"))) ctx.fail("a computed word in an option");
      return;
    }
    // An attached value (`--file=$(x)`) comes back as a new word holding the substitution's text.
    if (read.paths.some((p) => computed.has(p) || /[$`]/.test(p.text)))
      ctx.fail("a computed word where the command takes a file");
    else ctx.checkPaths(read.paths, cwd, "read");
  }

  function inner(n: Node, st: State): void {
    for (const c of n.namedChildren) statement(c, fresh(st), true);
  }

  /** A backtick body is read again from its unescaped text, as bash does (FOLLOWUPS F84). */
  function substitution(n: Node, st: State): void {
    if (!n.text.startsWith("`")) {
      inner(n, st);
      return;
    }
    walked.add(n.id);
    const body = backtickBody(n.text);
    const quoted = inQuotes(n);
    // Past the depth cap the body isn't read, so its commands would be missing: unparsed, not merely not understood.
    if (body === undefined || quoted === undefined || st.depth >= MAX_DEPTH) ctx.state.misread = true;
    else if (!walk.script(unescapeBackticks(body, quoted), fresh(st))) ctx.fail("nested script not parsed");
  }

  function word(n: Node, st: State): Word {
    switch (n.type) {
      case "word": {
        const braces = hasUnescaped(n.text, "{");
        if (braces) ctx.fail("brace expansion");
        return { text: unbackslash(n.text), literal: !braces, glob: hasUnescaped(n.text, "*?[") };
      }
      case "number":
        return { text: n.text, literal: true, glob: false };
      case "raw_string":
        return { text: n.text.slice(1, -1), literal: true, glob: false };
      case "string": {
        const loop = loopWord(n, st);
        if (loop) return loop;
        let literal = true;
        for (const p of n.namedChildren) {
          if (p.type === "string_content") continue;
          literal = false;
          if (p.type === "command_substitution") substitution(p, st);
          else {
            ctx.fail(`${p.type} in a quoted word`);
            inner(p, st);
          }
        }
        return literal ? { text: unescapeQuoted(n.text.slice(1, -1)), literal, glob: false } : opaque(n);
      }
      case "concatenation": {
        const parts = n.namedChildren.map((p) => word(p, st));
        const literal = parts.every((p) => p.literal && p.values === undefined);
        return {
          text: literal ? parts.map((p) => p.text).join("") : n.text,
          literal,
          glob: parts.some((p) => p.glob),
          ...(parts.some((p) => p.split) ? { split: true } : {}),
        };
      }
      case "command_substitution":
        substitution(n, st);
        return { ...opaque(n), split: true };
      case "process_substitution":
        ctx.fail("process substitution");
        inner(n, st);
        return opaque(n);
      case "simple_expansion": {
        const loop = loopWord(n, st);
        if (loop) return loop;
        ctx.fail(`variable ${n.text}`);
        return opaque(n);
      }
      default:
        ctx.fail(`${n.type} in a word`);
        inner(n, st);
        return opaque(n);
    }
  }

  function assignment(n: Node, st: State): { text: string; ok: boolean } {
    const name = n.childForFieldName("name")?.text ?? "";
    const valueNode = n.childForFieldName("value");
    const value = valueNode ? word(valueNode, st) : { text: "", literal: true, glob: false };
    return { text: `${name}=${value.text}`, ok: isSafeEnv(name) && value.literal && !value.glob };
  }

  /** Records a redirect on `sub`; false when it makes the command more than a read of a path inside the working directories. */
  function redirect(n: Node, sub: Subcommand, st: State): boolean {
    if (n.type === "herestring_redirect") {
      for (const c of n.namedChildren) word(c, st);
      return true;
    }
    if (n.type === "heredoc_redirect") {
      const quoted = /['"\\]/.test(n.namedChildren.find((c) => c.type === "heredoc_start")?.text ?? "");
      for (const c of n.namedChildren) {
        if (c.type === "heredoc_body") {
          if (!quoted) {
            for (const p of c.namedChildren) {
              if (p.type === "heredoc_content" || p.type === "simple_expansion") continue;
              ctx.fail("here-document with expansions");
              statement(p, fresh(st), true);
            }
            // tree-sitter leaves backticks in an unquoted body as plain text.
            for (const script of backticks(c.text)) {
              ctx.fail("here-document with command substitution");
              walk.script(unescapeBackticks(script, false), fresh(st));
            }
          }
        } else if (c.type !== "heredoc_start" && c.type !== "heredoc_end") statement(c, fresh(st), true);
      }
      return true;
    }
    const op = n.children.find((c) => !c.isNamed && /^(&>>?|>>?|>\||<|>&|<&|<>)$/.test(c.type))?.type ?? ">";
    const dest = n.childForFieldName("destination");
    if (dest === null) {
      ctx.fail("redirect without a target");
      return false;
    }
    if (op.endsWith("&") && (dest.type === "number" || dest.text === "-")) return true;
    const target = word(dest, st);
    if (!target.literal || target.glob || target.values) {
      ctx.fail("redirect target is not a literal path");
      return false;
    }
    if (target.text === "/dev/null") return true;
    if (target.text.startsWith("~")) ctx.fail("redirect to a ~ path");
    const abs = ctx.toAbsolute(target.text, st.cwd);
    const entry: Redirect = { op, target: abs };
    sub.redirects = [...(sub.redirects ?? []), entry];
    return op.startsWith("<") ? ctx.inside(abs) && !/^(\\\\|\/\/)[^\\/]/.test(target.text) : false;
  }

  function changeDirectory(name: string, args: Word[], st: State, cond: boolean): boolean {
    let target: string | undefined;
    if (name === "popd" && args.length === 0) target = st.stack.pop();
    else if (args.length === 0 && name === "cd") target = ctx.opts.home;
    else if (
      args.length === 1 &&
      args[0]?.literal &&
      !args[0].glob &&
      !/^-/.test(args[0].text) &&
      ctx.tildeOk(args[0].text)
    ) {
      target = ctx.toAbsolute(args[0].text, st.cwd);
      if (name === "pushd") st.stack.push(st.cwd);
    }
    if (target === undefined) {
      ctx.fail(`${name} without a literal target`);
      return false;
    }
    if (cond) ctx.fail(`${name} inside a condition or loop`);
    if (!ctx.opts.isDirectory(target)) {
      ctx.fail(`${name} target is not a directory`);
      return false;
    }
    st.cwd = target;
    return ctx.inside(target);
  }

  function command(n: Node, st: State, cond: boolean, preset: Node[]): void {
    walked.add(n.id);
    if (misread(n)) ctx.state.misread = true;
    const sub: Subcommand = { argv: [], cwd: st.cwd };
    const args: Word[] = [];
    let name: Word | undefined;
    let prefixed = false;
    let redirectsOk = true;
    for (const c of [...n.namedChildren, ...preset]) {
      if (c.type === "comment") continue;
      if (c.type === "variable_assignment") {
        const a = assignment(c, st);
        if (!a.ok) ctx.fail(`assignment ${a.text.split("=")[0]}`);
        sub.argv.push(a.text);
        prefixed = true;
      } else if (c.type === "command_name") name = word(c.firstNamedChild ?? c, st);
      else if (REDIRECTS.has(c.type)) redirectsOk = redirect(c, sub, st) && redirectsOk;
      else args.push(word(c, st));
    }
    ctx.commands.push(sub);
    if (name === undefined) return;
    if (!name.literal || name.glob || name.values) {
      ctx.state.literalNames = false;
      ctx.fail("command name is not literal");
    }
    sub.argv.push(name.text, ...args.map((a) => a.text));
    sub.literalWords = literalTexts(args);
    if (NEVER_UNDERSTOOD.has(name.text)) ctx.fail(`${name.text}`);
    if (commandName(name.text) === "xargs") {
      const { starts, none } = xargsCommandStarts([name.text, ...args.map((a) => a.text)]);
      if (none || starts.length === 0 || args.some((a) => !a.literal || a.values !== undefined)) {
        ctx.state.literalNames = false;
        ctx.fail("xargs runs a computed command");
      }
    }
    wrapped(name, args, st);
    if (name.text === "cd" || name.text === "pushd" || name.text === "popd") {
      const stayed = changeDirectory(name.text, args, st, cond);
      sub.readOnly = stayed && name.text === "cd" && redirectsOk && !prefixed;
      return;
    }
    if (prefixed) return;
    if (name.text === "tee") {
      const targets = args.filter((a) => !(a.literal && a.text.startsWith("-")));
      if (targets.some((t) => !t.literal || t.glob || t.text.startsWith("~"))) ctx.fail("tee target needs approval");
      ctx.checkPaths(
        targets.filter((t) => t.literal && !t.glob),
        st.cwd,
        "edit",
      );
      return;
    }
    const result = classify(name.text, args);
    if (!result.ok) {
      if (/glob/.test(result.reason)) ctx.fail(result.reason);
      computedRead(name.text, args, st.cwd);
      return;
    }
    if (result.paths.length === 0 && CWD_DEFAULT.has(name.text))
      result.paths.push({ text: ".", literal: true, glob: false });
    const awayGit = name.text === "git" && st.cwd !== ctx.opts.cwd && !ctx.opts.workingDirs.some((d) => d === st.cwd);
    sub.readOnly = ctx.checkPaths(result.paths, st.cwd, "read") && redirectsOk && !awayGit;
  }

  /** What a wrapper runs (`sudo sh -c …`, `/usr/bin/env cat .env`, `find -exec`) gets the same checks as a bare command. */
  function wrapped(name: Word, args: Word[], st: State): void {
    const words = new Map<string, Word>();
    for (const w of [name, ...args]) {
      const seen = words.get(w.text);
      words.set(w.text, seen === undefined || (seen.literal && !w.literal) || w.glob ? w : seen);
    }
    const { argvs, complete } = unwrapCommand([name.text, ...args.map((a) => a.text)]);
    if (!complete) ctx.fail("a wrapper's options can't all be checked");
    for (const [i, v] of argvs.entries()) {
      const head = commandName(v[0]);
      const rest = i === 0 ? args : v.slice(1).map((text) => words.get(text) ?? { text, literal: true, glob: false });
      if (NEVER_UNDERSTOOD.has(head)) ctx.fail(head);
      if (head === "env" && rest.some((a) => /^-[^-]*[CS]/.test(a.text) || /^--(c|s|ch|sp)/.test(a.text)))
        ctx.fail("env -C");
      if (SHELLS.has(head)) shellScript(rest, st);
      if (i === 0 && head === name.text) continue;
      const read = classify(head, rest);
      if (read.ok) ctx.checkPaths(read.paths, st.cwd, "read");
      else computedRead(head, rest, st.cwd);
    }
  }

  function shellScript(args: Word[], st: State): void {
    ctx.fail("sh -c runs a nested script");
    const at = shellScriptAt(args.map((a) => a.text));
    const script = at < 0 ? undefined : args[at];
    if (script === undefined) return;
    if (!script.literal) {
      ctx.state.literalNames = false;
      return;
    }
    if (st.depth >= MAX_DEPTH) ctx.state.misread = true;
    else if (!walk.script(script.text, fresh(st))) ctx.fail("nested script not parsed");
  }

  function forLoop(n: Node, st: State): void {
    const variable = n.childForFieldName("variable")?.text;
    const values: string[] = [];
    for (const w of n.childrenForFieldName("value").map((c) => word(c, st))) {
      if (!w.literal) ctx.fail("for loop over a computed list");
      else if (w.glob) values.push(...ctx.opts.glob(w.text, st.cwd, ctx.deadline.at));
      else values.push(w.text);
    }
    const body = fresh(st);
    if (variable !== undefined) body.loops.set(variable, values.length > 0 ? values : [""]);
    const loop = n.childForFieldName("body");
    if (loop) statement(loop, body, true);
  }

  function statement(n: Node, st: State, cond: boolean): void {
    if (n.type === "comment") return;
    if (n.children.some((c) => c.type === "&")) ctx.fail("background job");
    switch (n.type) {
      case "program":
      case "do_group":
      case "else_clause":
      case "elif_clause":
      case "if_statement":
      case "while_statement": {
        const nested = cond || n.type !== "program";
        for (const c of n.namedChildren) statement(c, st, nested);
        return;
      }
      case "list": {
        let rhs = cond;
        for (const c of n.children) {
          if (!c.isNamed) rhs = true;
          else statement(c, st, rhs);
        }
        return;
      }
      case "pipeline":
        for (const c of n.namedChildren) statement(c, fresh(st), cond);
        return;
      case "negated_command":
        for (const c of n.namedChildren) statement(c, st, cond);
        return;
      case "command":
        command(n, st, cond, []);
        return;
      case "redirected_statement": {
        const body = n.childForFieldName("body");
        const before = ctx.commands.length;
        if (body) statement(body, st, cond);
        // `a && b > f` parses with the redirect on the whole list, but it applies to `b` only.
        const made = ctx.commands.slice(before);
        const targets = body?.type === "list" || body?.type === "pipeline" ? made.slice(-1) : made;
        const [first, ...others] = targets;
        if (first === undefined) {
          ctx.fail("redirect without a command");
          return;
        }
        for (const r of n.childrenForFieldName("redirect")) {
          if (redirect(r, first, st)) continue;
          for (const t of targets) t.readOnly = false;
        }
        for (const t of others) t.redirects = first.redirects ?? [];
        return;
      }
      case "variable_assignment": {
        const a = assignment(n, st);
        if (!a.ok) ctx.fail(`assignment ${a.text.split("=")[0]}`);
        ctx.commands.push({ argv: [a.text], readOnly: a.ok });
        return;
      }
      case "declaration_command": {
        // A declaration whose name holds an expansion parses as bare words, not an assignment: recording them keeps
        // every word-scan over the commands able to see the text (FOLLOWUPS F51).
        ctx.fail("unsupported syntax declaration_command");
        for (const c of n.namedChildren) {
          if (c.type === "variable_assignment") {
            const a = assignment(c, st);
            if (!a.ok) ctx.fail(`assignment ${a.text.split("=")[0]}`);
            ctx.commands.push({ argv: [a.text], readOnly: a.ok });
          } else ctx.commands.push({ argv: [word(c, st).text] });
        }
        return;
      }
      case "for_statement":
        forLoop(n, st);
        return;
      default:
        ctx.fail(`unsupported syntax ${n.type}`);
        if (n.type === "command_substitution" && n.text.startsWith("`")) substitution(n, st);
        else for (const c of n.namedChildren) if (c.childCount > 0) statement(c, fresh(st), true);
    }
  }

  statement(root, st, false);
  return walked;
}
