// Walks a PowerShell syntax tree: pipelines of plain commands only, with aliases canonicalized (permissions §3.2, §4.0).
import type { Node } from "web-tree-sitter";
import type { Redirect, Subcommand } from "../rules/index.ts";
import type { Context } from "./context.ts";
import type { Word } from "./read-only.ts";

const ALIASES: Record<string, string> = {
  ls: "Get-ChildItem",
  dir: "Get-ChildItem",
  gci: "Get-ChildItem",
  cat: "Get-Content",
  gc: "Get-Content",
  type: "Get-Content",
  pwd: "Get-Location",
  gl: "Get-Location",
  sls: "Select-String",
  gi: "Get-Item",
  measure: "Measure-Object",
  cd: "Set-Location",
  chdir: "Set-Location",
  sl: "Set-Location",
  pushd: "Push-Location",
  popd: "Pop-Location",
  rm: "Remove-Item",
  del: "Remove-Item",
  ri: "Remove-Item",
  rmdir: "Remove-Item",
  rd: "Remove-Item",
  erase: "Remove-Item",
  cp: "Copy-Item",
  copy: "Copy-Item",
  cpi: "Copy-Item",
  mv: "Move-Item",
  move: "Move-Item",
  mi: "Move-Item",
  curl: "Invoke-WebRequest",
  wget: "Invoke-WebRequest",
  iwr: "Invoke-WebRequest",
  iex: "Invoke-Expression",
  echo: "Write-Output",
  sc: "Set-Content",
  ac: "Add-Content",
  ni: "New-Item",
};

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
  const quoted = /^'([^']*)'$/.exec(t)?.[1] ?? /^"([^"$`]*)"$/.exec(t)?.[1];
  if (quoted !== undefined) return { text: quoted, literal: true, glob: false };
  const plain = n.type === "generic_token" || /^-?\d+$/.test(t);
  return { text: t, literal: plain, glob: plain && /[*?[]/.test(t) };
}

export type PowerShellState = { cwd: string; stack: string[] };

export function walkPowerShell(root: Node, ctx: Context, st: PowerShellState): void {
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
    const sub: Subcommand = { argv: [] };
    const nameNode = n.childForFieldName("command_name");
    const raw = nameNode?.text ?? "";
    const canonical = ALIASES[raw.toLowerCase()] ?? raw;
    if (nameNode === null || !/^[A-Za-z][\w.-]*$/.test(raw)) {
      ctx.state.literalNames = false;
      ctx.fail("command name is not literal");
    }
    sub.argv.push(canonical);
    const parsed: Array<{ param?: string; word?: Word }> = [];
    let redirectsOk = true;
    for (const c of n.childForFieldName("command_elements")?.namedChildren ?? []) {
      if (c.type === "command_argument_sep") continue;
      if (c.type === "command_parameter") {
        sub.argv.push(c.text);
        parsed.push(
          c.text.includes(":")
            ? { word: { text: c.text, literal: false, glob: false } }
            : { param: c.text.slice(1).toLowerCase() },
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
        const w = literal(c);
        if (!w.literal) ctx.fail(`${c.type} argument`);
        sub.argv.push(w.text);
        parsed.push({ word: { ...w, text: w.text.replaceAll("\\", "/") } });
      }
    }
    ctx.commands.push(sub);
    const lower = canonical.toLowerCase();
    if (lower === "set-location" || lower === "push-location" || lower === "pop-location") {
      const target = parsed.find((p) => p.word !== undefined)?.word;
      if (lower === "pop-location" && st.stack.length > 0) st.cwd = st.stack.pop() ?? st.cwd;
      else if (target?.literal && !target.glob && parsed.length === 1) {
        if (lower === "push-location") st.stack.push(st.cwd);
        st.cwd = ctx.toAbsolute(target.text, st.cwd);
        sub.readOnly = lower === "set-location" && ctx.inside(st.cwd) && redirectsOk;
      } else ctx.fail(`${canonical} without a literal target`);
      return;
    }
    const paths = classify(lower, parsed);
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
