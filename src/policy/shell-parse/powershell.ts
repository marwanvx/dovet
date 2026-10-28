// Walks a PowerShell syntax tree: pipelines of plain commands only, with aliases canonicalized (permissions §3.2, §4.0).
import type { Node } from "web-tree-sitter";
import {
  canonicalCmdlet,
  commandName,
  type Redirect,
  type Subcommand,
  shellScriptAt,
  unwrapCommand,
} from "../rules/index.ts";
import { SHELLS } from "./bash.ts";
import type { Context } from "./context.ts";
import { literalTexts, type Word } from "./read-only.ts";

type Cmdlet = {
  switches?: string[];
  valued?: string[];
  paths: string[];
  positional: "paths" | "pattern" | "words" | "none";
};
const PATHS = ["path", "literalpath"];
const FILTERS = ["filter", "include", "exclude"];
const CMDLETS: Record<string, Cmdlet> = {
  "get-childitem": {
    switches: ["recurse", "force", "name", "file", "directory", "hidden", "readonly", "system", "followsymlink"],
    valued: [...FILTERS, "depth"],
    paths: PATHS,
    positional: "paths",
  },
  "get-content": {
    switches: ["raw"],
    valued: ["totalcount", "tail", "head", "first", "last", "encoding", "readcount", "delimiter"],
    paths: PATHS,
    positional: "paths",
  },
  "get-location": { paths: [], positional: "none" },
  "select-string": {
    switches: ["simplematch", "casesensitive", "list", "notmatch", "quiet", "allmatches"],
    valued: ["pattern", "context", "encoding", ...FILTERS.slice(1)],
    paths: PATHS,
    positional: "pattern",
  },
  "get-item": { switches: ["force"], valued: FILTERS, paths: PATHS, positional: "paths" },
  "test-path": { switches: ["isvalid"], valued: ["pathtype", ...FILTERS], paths: PATHS, positional: "paths" },
  "measure-object": {
    switches: ["line", "word", "character", "sum", "average", "maximum", "minimum", "ignorewhitespace"],
    valued: ["property"],
    paths: [],
    positional: "words",
  },
};

function literal(n: Node): Word {
  const t = n.text;
  const quoted = /^'((?:[^']|'')*)'$/.exec(t)?.[1]?.replaceAll("''", "'") ?? /^"([^"$`]*)"$/.exec(t)?.[1];
  if (quoted !== undefined) return { text: quoted, literal: true, glob: false };
  // A here-string's body: a verbatim one is literal, an expandable one only without `$` or a backtick.
  const here = /^@(['"])\r?\n([\s\S]*?)\r?\n\1@$/.exec(t);
  if (here !== null) {
    const body = here[2] ?? "";
    return { text: body, literal: here[1] === "'" || !/[$`]/.test(body), glob: false };
  }
  const expandable = /^"([\s\S]*)"$/.exec(t)?.[1];
  if (expandable !== undefined) return { text: expandable, literal: false, glob: false };
  const plain = n.type === "generic_token" || /^-?\d+$/.test(t);
  return { text: t, literal: plain, glob: plain && /[*?[]/.test(t) };
}

/** A bareword as PowerShell passes it: a backtick before a plain character is dropped; `` `n ``-style escapes stay. */
const dropEscapes = (t: string): string => t.replace(/`([^0abefnrtvu])/gs, "$1");

/** Commands whose arguments become a command line this analyzer doesn't read (bash's `eval`, permissions §4.0). */
const EVALUATORS = new Set([
  ...["invoke-expression", "start-process", "start", "invoke-item", "wsl", "schtasks", "register-scheduledtask"],
  ...["invoke-wmimethod", "invoke-cimmethod", "pwsh", "pwsh-preview", "powershell", "powershell_ise"],
  // A name defined earlier in the script resolves to whatever it was set to; a module or COM object brings its own,
  // and a new drive can map any name onto the alias: or function: provider.
  ...["set-alias", "new-alias", "sal", "nal", "import-alias", "ipal", "import-module", "ipmo", "new-object"],
  ...["new-psdrive", "ndr", "mount"],
]);
// `alias:g`, `Alias::g`, `Microsoft.PowerShell.Core\Function::g` or `…/Function::g`.
const NAME_PROVIDER = /(^|[\\/])(alias|function):/i;
// Only a cmdlet can write a provider path; a Get/Select/Test one only reads it.
const ITEM_WRITER = /^(?!(get|select|test|measure|write|format)-)[a-z]+-[a-z]+$/i;

/** A provider-qualified path (`env:PATH`, `HKCU:\\x`, `FileSystem::/etc`): not a file under the working directories. */
const isProviderPath = (text: string): boolean => text.includes("::") || /^[A-Za-z][\w.]+:/.test(text);

export type PowerShellState = { cwd: string; stack: string[] };

/** `script` parses and walks a bash script (what `sh -c` and git's own command options run); false when it couldn't. */
export function walkPowerShell(
  root: Node,
  ctx: Context,
  st: PowerShellState,
  script: (text: string, cwd: string) => boolean,
): void {
  function classify(name: string, parsed: Array<{ param?: string; word?: Word }>): Word[] | undefined {
    const spec = CMDLETS[name];
    if (spec === undefined) return undefined;
    const paths: Word[] = [];
    const positional: Word[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const { param, word } = parsed[i] ?? {};
      if (word !== undefined) {
        if (!word.literal) return undefined;
        positional.push(word);
      } else if (param !== undefined) {
        if (spec.switches?.includes(param)) continue;
        const isPath = spec.paths.includes(param);
        if (!isPath && !spec.valued?.includes(param)) return undefined;
        const value = parsed[++i]?.word;
        if (value === undefined || !value.literal) return undefined;
        if (isPath) paths.push(value);
        else if (value.glob) return undefined;
      }
    }
    const [first, ...rest] = positional;
    if (spec.positional === "paths") paths.push(...positional);
    else if (spec.positional === "pattern" && first !== undefined) {
      const hasPattern = parsed.some((p) => p.param === "pattern");
      paths.push(...(hasPattern ? positional : rest));
      if (!hasPattern && first.glob) return undefined;
    } else if (spec.positional !== "words" && positional.length > 0) return undefined;
    return paths;
  }

  function command(n: Node): void {
    const sub: Subcommand = { argv: [], cwd: st.cwd };
    const nameNode = n.childForFieldName("command_name");
    // The checks read the name PowerShell runs (``g`it`` is `git`); an escaped name still isn't literal.
    const raw = dropEscapes(nameNode?.text ?? "");
    const canonical = canonicalCmdlet(raw);
    if (nameNode === null || raw !== nameNode.text || !/^[A-Za-z][\w.-]*$/.test(raw)) {
      ctx.state.literalNames = false;
      ctx.fail("command name is not literal");
    }
    sub.argv.push(canonical);
    const parsed: Array<{ param?: string; word?: Word }> = [];
    let redirectsOk = true;
    let computed = false;
    const words: Word[] = [];
    for (const c of n.childForFieldName("command_elements")?.namedChildren ?? []) {
      if (c.type === "command_argument_sep") continue;
      if (c.type === "command_parameter") {
        const text = dropEscapes(c.text);
        if (c.text.includes("`")) ctx.fail("a backtick escape in a parameter");
        sub.argv.push(text);
        words.push({ text, literal: !text.includes(":"), glob: false });
        parsed.push(
          text.includes(":") ? { word: { text, literal: false, glob: false } } : { param: text.slice(1).toLowerCase() },
        );
      } else if (c.type === "redirection") {
        const file = c.namedChildren.find((x) => x.type === "redirected_file_name");
        const op = c.namedChildren.find((x) => x.type === "file_redirection_operator")?.text ?? ">";
        const w = file ? literal(file.namedChildren.find((x) => x.type !== "command_argument_sep") ?? file) : undefined;
        if (w === undefined || !w.literal || w.glob) {
          ctx.fail("redirect target is not a literal path");
          redirectsOk = false;
        } else if (!/^(\$null|nul)$/i.test(w.text)) {
          const entry: Redirect = { op, target: ctx.toAbsolute(w.text.replaceAll("\\", "/"), st.cwd) };
          sub.redirects = [...(sub.redirects ?? []), entry];
          redirectsOk = false;
        }
      } else {
        const raw = literal(c);
        if (!raw.literal) {
          ctx.fail(`${c.type} argument`);
          computed = true;
        }
        // PowerShell drops a bareword's escape (``a`lias:g`` is `alias:g`): the checks read what runs, and the
        // command isn't understood, since what `` `n `` and the like become isn't read.
        const escaped = c.type === "generic_token" && raw.text.includes("`");
        if (escaped) ctx.fail("a backtick escape in a bareword");
        const w = escaped ? { ...raw, text: dropEscapes(raw.text) } : raw;
        sub.argv.push(w.text);
        words.push(w);
        parsed.push({ word: { ...w, text: w.text.replaceAll("\\", "/") } });
      }
    }
    // A bareword keeps its backtick escapes (`--e`dit`) and `$name` expansions in its text, so that text isn't what runs.
    sub.literalWords = literalTexts(words).filter((t) => !/[`$]/.test(t));
    ctx.commands.push(sub);
    const { argvs, complete } = unwrapCommand(sub.argv);
    if (!complete) ctx.fail("a wrapper's options can't all be checked");
    for (const v of argvs) {
      if (EVALUATORS.has(commandName(v[0]))) ctx.fail(`${v[0]} runs its arguments as a command`);
      if (ITEM_WRITER.test(commandName(v[0])) && v.some((w) => NAME_PROVIDER.test(w)))
        ctx.fail("a cmdlet naming the alias: or function: provider");
      if (!SHELLS.has(commandName(v[0]))) continue;
      ctx.fail("sh -c runs a nested script");
      const at = shellScriptAt(v.slice(1));
      const text = at < 0 ? undefined : v[at + 1];
      // A script built from a computed word may read as more once PowerShell expands it.
      if (computed) ctx.state.literalNames = false;
      if (text !== undefined && !script(text, st.cwd)) ctx.fail("nested script not parsed");
    }
    const lower = canonical.toLowerCase();
    if (lower === "set-location" || lower === "push-location" || lower === "pop-location") {
      const target = parsed.find((p) => p.word !== undefined)?.word;
      if (lower === "pop-location" && st.stack.length > 0) st.cwd = st.stack.pop() ?? st.cwd;
      else if (target?.literal && !target.glob && parsed.length === 1) {
        if (lower === "push-location") st.stack.push(st.cwd);
        const next = ctx.toAbsolute(target.text, st.cwd);
        if (isProviderPath(target.text) || !ctx.opts.isDirectory(next)) {
          ctx.fail(`${canonical} target is not a directory`);
          return;
        }
        st.cwd = next;
        sub.readOnly = lower === "set-location" && ctx.inside(st.cwd) && redirectsOk;
      } else ctx.fail(`${canonical} without a literal target`);
      return;
    }
    const paths = classify(lower, parsed);
    if (paths?.some((w) => isProviderPath(w.text))) {
      ctx.fail("provider path");
      return;
    }
    if (paths?.length === 0 && lower === "get-childitem") paths.push({ text: ".", literal: true, glob: false });
    if (paths !== undefined) sub.readOnly = ctx.checkPaths(paths, st.cwd, "read") && redirectsOk;
  }

  function walk(n: Node): void {
    switch (n.type) {
      case "command":
        command(n);
        return;
      case "program":
      case "statement_list":
      case "pipeline":
      case "pipeline_chain":
        for (const c of n.namedChildren) walk(c);
        return;
      case "empty_statement":
      case "pipeline_chain_tail":
        return;
      default:
        ctx.fail(`unsupported syntax ${n.type}`);
        for (const c of n.namedChildren) if (c.childCount > 0) walk(c);
    }
  }
  walk(root);
}
