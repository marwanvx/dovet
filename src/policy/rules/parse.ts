// Rule text to compiled rules (permissions §3.1 "Robust rule loading").
import { parseTree } from "jsonc-parser";
import { compilePath, type PathContext, type PathMatcher } from "./paths.ts";
import { canonicalCmdlet, normalizeShellPattern, shellPattern } from "./shell.ts";

export type Behavior = "deny" | "ask" | "allow";
export type RuleText = { text: string; line?: number };
export type RuleSource = { file: string; baseDir: string; allow?: RuleText[]; ask?: RuleText[]; deny?: RuleText[] };
export type RuleIssue = { severity: "error" | "warning"; message: string; file: string; line?: number };
export type RuleContext = PathContext & {
  /** Names the unknown-tool check accepts (`mcp__` tools always pass); absent = no check. */
  knownTools?: ReadonlySet<string>;
  /** Top-level scalar input parameters per tool, which `Tool(param:value)` rules may name. */
  toolParams?: ReadonlyMap<string, ReadonlySet<string>>;
};

export type Matcher =
  | { kind: "tool" }
  | { kind: "shell"; re: RegExp; text: string }
  | { kind: "path"; path: PathMatcher; group: string }
  | { kind: "domain"; re: RegExp; text: string }
  | { kind: "param"; name: string; re: RegExp };

export type Rule = {
  behavior: Behavior;
  raw: string;
  tool: string;
  toolRe: RegExp | undefined;
  matcher: Matcher;
  file: string;
  baseDir: string;
  line: number | undefined;
};

const PRIMARY_FIELDS = new Set(["command", "file_path", "path", "url"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
export const isShellTool = (tool: string): boolean => SHELL_TOOLS.has(tool);

const escapeRegExp = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const wildcard = (s: string, any: string): RegExp => new RegExp(`^${s.split("*").map(escapeRegExp).join(any)}$`, "is");

/** The `permissions` rule strings of a settings file with their 1-based line numbers. */
export function ruleTexts(fileText: string): Pick<RuleSource, Behavior> {
  const out: Pick<RuleSource, Behavior> = { allow: [], ask: [], deny: [] };
  const permissions = parseTree(fileText)?.children?.find((p) => p.children?.[0]?.value === "permissions")
    ?.children?.[1];
  for (const behavior of ["allow", "ask", "deny"] as const) {
    const list = permissions?.children?.find((p) => p.children?.[0]?.value === behavior)?.children?.[1];
    for (const item of list?.children ?? []) {
      if (typeof item.value !== "string") continue;
      const line = fileText.slice(0, item.offset).split("\n").length;
      out[behavior]?.push({ text: item.value, line });
    }
  }
  return out;
}

export function parseRuleText(raw: string): { tool: string; spec?: string } | string {
  const tool = /^[A-Za-z0-9_*]+/.exec(raw)?.[0];
  if (tool === undefined) return `"${raw}" doesn't start with a tool name`;
  const rest = raw.slice(tool.length);
  if (rest === "") return { tool };
  if (!rest.startsWith("(")) return `text after the tool name in "${raw}"`;
  const close = rest.lastIndexOf(")");
  if (close < 0) return `"${raw}" is missing its closing parenthesis`;
  if (close !== rest.length - 1) return `text after the closing parenthesis in "${raw}"`;
  const spec = rest.slice(1, close);
  return spec === "*" || spec === "" ? { tool } : { tool, spec };
}

export function compileRule(
  behavior: Behavior,
  { text: raw, line }: RuleText,
  src: RuleSource,
  c: RuleContext,
  issue: (severity: "error" | "warning", message: string) => void,
): Rule | undefined {
  if (raw.includes("\0"))
    return void issue("warning", `rule ${JSON.stringify(raw)} contains a NUL byte and matches nothing`);
  const parsed = parseRuleText(raw);
  if (typeof parsed === "string") return void issue("error", `invalid rule: ${parsed}`);
  const { tool, spec } = parsed;
  const glob = tool.includes("*");
  if (glob && behavior === "allow" && !/^mcp__[^*]+__/.test(tool)) {
    return void issue(
      "warning",
      `allow rule ${raw}: a tool-name glob is only allowed after mcp__<server>__, so the rule is ignored`,
    );
  }
  if (!glob && behavior !== "allow" && c.knownTools && !c.knownTools.has(tool) && !tool.startsWith("mcp__")) {
    issue("warning", `${behavior} rule ${raw}: unknown tool "${tool}" (a typo?)`);
  }
  const base = {
    behavior,
    raw,
    tool,
    toolRe: glob ? wildcard(tool, ".*") : undefined,
    file: src.file,
    baseDir: src.baseDir,
    line,
  };
  const keep = (matcher: Matcher): Rule => ({ ...base, matcher });
  const skip = (why: string): undefined => void issue("warning", `${behavior} rule ${raw}: ${why}`);
  if (spec === undefined) return keep({ kind: "tool" });
  if (tool === "Write" || tool === "Glob")
    return skip(
      `files are matched by ${tool === "Write" ? "Edit" : "Read"} rules, so use ${tool === "Write" ? "Edit" : "Read"}(...) instead`,
    );
  if (tool === "Read" || tool === "Edit") {
    if (/^(file_path|path):/.test(spec)) return skip("a rule on the primary field is rejected; write the path itself");
    const { matcher, warning } = compilePath(spec, behavior, src.baseDir, c);
    if (warning !== undefined) skip(warning);
    return matcher && keep({ kind: "path", path: matcher, group: `${src.file}\0${behavior}\0${tool}` });
  }
  if (isShellTool(tool)) {
    const param = /^([A-Za-z_]\w*):(.*)$/s.exec(spec);
    if (param?.[1] !== undefined && (PRIMARY_FIELDS.has(param[1]) || c.toolParams?.get(tool)?.has(param[1]))) {
      return parameterRule(param[1], param[2] ?? "", behavior, skip, keep);
    }
    const text = normalizeShellPattern(spec);
    if (text !== spec.trim())
      skip(`":*" is read as " *": the rule is ${tool}(${text}), which also matches the bare command`);
    const star = text.indexOf("*");
    if (
      behavior === "allow" &&
      star >= 0 &&
      star < text.length - 1 &&
      text.slice(0, star).split(/\s+/).filter(Boolean).length < 2
    ) {
      skip("a * before the subcommand lets the rule match more than it seems to");
    }
    const pattern = tool === "PowerShell" ? text.replace(/^[^\s*]+/, canonicalCmdlet) : text;
    return keep({ kind: "shell", re: shellPattern(pattern, tool === "PowerShell"), text: pattern });
  }
  if (tool === "WebFetch" && spec.startsWith("domain:")) {
    const domain = spec.slice(7).trim().toLowerCase().replace(/\.$/, "");
    const re =
      domain === "*"
        ? /./
        : domain.startsWith("*.")
          ? new RegExp(`^[^]+\\.${escapeRegExp(domain.slice(2))}$`)
          : wildcard(domain, "[^.]*");
    return keep({ kind: "domain", re, text: domain });
  }
  const param = /^([A-Za-z_]\w*):(.*)$/s.exec(spec);
  if (param?.[1] === undefined) return skip("the specifier isn't understood for this tool, so the rule is ignored");
  return parameterRule(param[1], param[2] ?? "", behavior, skip, keep);
}

function parameterRule(
  name: string,
  value: string,
  behavior: Behavior,
  skip: (why: string) => undefined,
  keep: (m: Matcher) => Rule,
): Rule | undefined {
  if (behavior === "allow") return skip("parameter rules work only in deny and ask");
  if (PRIMARY_FIELDS.has(name))
    return skip(`"${name}" is the tool's primary field, which compound commands bypass; the rule is rejected`);
  return keep({ kind: "param", name, re: wildcard(value, ".*") });
}
