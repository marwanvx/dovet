// Deny → ask → allow evaluation, unreachable-rule detection and rule examples (permissions §3.1).
import {
  type Behavior,
  compileRule,
  isShellTool,
  type Rule,
  type RuleContext,
  type RuleIssue,
  type RuleSource,
} from "./parse.ts";
import { type PathForms, pathForms, pathMatches } from "./paths.ts";
import { needsExactRule, type Subcommand, shellVariants, splitCommand } from "./shell.ts";

export type RuleSet = { list: readonly Rule[]; ctx: RuleContext };
export type RuleMatch = { behavior: Behavior; rule: string; file: string; line?: number };

export type RuleCall = {
  tool: string;
  cwd: string;
  input?: Record<string, unknown>;
  paths?: Array<{ access: "read" | "edit"; path: string }>;
  /** Parsed subcommands of a shell call; absent when it couldn't be parsed. */
  commands?: Subcommand[];
  /** False when the analyzer did not fully understand the command: allow rules then never apply to it (permissions §4.0). */
  checkable?: boolean;
  host?: string;
};

const ORDER: Behavior[] = ["deny", "ask", "allow"];
const where = (r: { file: string; line?: number | undefined }): string =>
  r.line === undefined ? r.file : `${r.file}:${r.line}`;

export function loadRules(sources: RuleSource[], ctx: RuleContext): { rules: RuleSet; issues: RuleIssue[] } {
  const issues: RuleIssue[] = [];
  const list: Rule[] = [];
  for (const src of sources) {
    for (const behavior of ORDER) {
      for (const text of src[behavior] ?? []) {
        const rule = compileRule(behavior, text, src, ctx, (severity, message) =>
          issues.push({ severity, message, file: src.file, ...(text.line === undefined ? {} : { line: text.line }) }),
        );
        if (rule !== undefined) list.push(rule);
      }
    }
  }
  list.sort((a, b) => ORDER.indexOf(a.behavior) - ORDER.indexOf(b.behavior));
  issues.push(...unreachable(list));
  return { rules: { list, ctx }, issues };
}

const toolMatches = (rule: Rule, tool: string): boolean =>
  rule.toolRe !== undefined ? rule.toolRe.test(tool) : rule.tool === tool;

type Resolved = { unresolved: boolean; forms: Array<PathForms & { access: "read" | "edit" }>; cwds: string[] };

function resolve(call: RuleCall, ctx: RuleContext): Resolved {
  const paths = [...(call.paths ?? [])];
  for (const sub of call.commands ?? []) {
    for (const { op, target } of sub.redirects ?? []) {
      if (target !== "/dev/null" && !/^nul$/i.test(target))
        paths.push({ access: op.startsWith("<") ? "read" : "edit", path: target });
    }
  }
  const forms = paths.flatMap((p) => {
    const f = pathForms(p.path, call.cwd, ctx);
    return f === undefined ? [] : [{ ...f, access: p.access }];
  });
  const cwd = pathForms(call.cwd, call.cwd, ctx);
  return {
    unresolved: forms.length < paths.length,
    forms,
    cwds: [...new Set(cwd === undefined ? [] : [cwd.requested, cwd.canonical])],
  };
}

/** Does a path rule match the call's paths? Deny and ask need one path (either spelling); allow needs every path in both spellings. */
function pathHits(rule: Rule, r: Resolved, os: RuleContext["os"], strict: boolean): boolean {
  if (rule.matcher.kind !== "path") return false;
  const { path } = rule.matcher;
  const applies = (access: "read" | "edit") =>
    rule.tool === "Read" ? access === "read" || !strict : access === "edit";
  const one = (p: string) => pathMatches(path, p, r.cwds, os);
  const hit = (f: Resolved["forms"][number]) => one(f.requested) || one(f.canonical);
  return strict
    ? !r.unresolved &&
        r.forms.length > 0 &&
        r.forms.every((f) => applies(f.access) && one(f.requested) && one(f.canonical))
    : r.forms.some((f) => applies(f.access) && hit(f));
}

function pathRuleDecides(set: RuleSet, rule: Rule, r: Resolved, strict: boolean): boolean {
  const { matcher } = rule;
  if (matcher.kind !== "path" || matcher.path.negate || !pathHits(rule, r, set.ctx.os, strict)) return false;
  const later = set.list.slice(set.list.indexOf(rule) + 1);
  return !later.some(
    (n) =>
      n.matcher.kind === "path" &&
      n.matcher.path.negate &&
      n.matcher.group === matcher.group &&
      pathHits(n, r, set.ctx.os, false),
  );
}

function subHit(rule: Rule, sub: Subcommand): boolean {
  const m = rule.matcher;
  if (m.kind !== "shell") return false;
  const variants = shellVariants(sub.argv, rule.behavior !== "allow");
  const exactOnly =
    rule.behavior === "allow" && m.text.includes("*") && variants.some((t) => needsExactRule(t.split(" ")));
  return !exactOnly && variants.some((t) => m.re.test(t));
}

function otherHit(rule: Rule, call: RuleCall): boolean {
  const m = rule.matcher;
  if (!toolMatches(rule, call.tool)) return false;
  switch (m.kind) {
    case "tool":
      return true;
    case "shell":
      return (call.commands ?? []).some((sub) => subHit(rule, sub));
    case "domain":
      return call.host !== undefined && m.re.test(call.host.toLowerCase().replace(/\.$/, ""));
    case "param": {
      const v = call.input?.[m.name];
      return (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && m.re.test(String(v));
    }
    case "path":
      return false;
  }
}

const matchOf = (rule: Rule): RuleMatch => ({
  behavior: rule.behavior,
  rule: rule.raw,
  file: rule.file,
  ...(rule.line === undefined ? {} : { line: rule.line }),
});

/** The rule that decides the call (deny, then ask, then allow; the first match wins), or undefined when none does. */
export function evaluateRules(set: RuleSet, call: RuleCall): RuleMatch | undefined {
  const r = resolve(call, set.ctx);
  for (const rule of set.list) {
    if (rule.behavior === "allow") break;
    if (rule.matcher.kind === "path" ? pathRuleDecides(set, rule, r, false) : otherHit(rule, call))
      return matchOf(rule);
  }
  const allows = set.list.filter((rule) => rule.behavior === "allow");
  const bare = allows.find((a) => a.matcher.kind === "tool" && toolMatches(a, call.tool));
  if (bare !== undefined) return matchOf(bare);
  if (isShellTool(call.tool)) {
    if (call.checkable === false) return undefined;
    const subs = call.commands ?? [];
    const used = subs.map((sub) => allows.find((a) => toolMatches(a, call.tool) && subHit(a, sub)));
    const first = used.find((u) => u !== undefined);
    const covered = subs.every((sub, i) => used[i] !== undefined || sub.readOnly === true);
    return first !== undefined && covered ? matchOf(first) : undefined;
  }
  const hit = allows.find((a) => (a.matcher.kind === "path" ? pathRuleDecides(set, a, r, true) : otherHit(a, call)));
  return hit && matchOf(hit);
}

function covers(b: Rule, a: Rule): boolean {
  if (b.matcher.kind === "path" && b.matcher.path.negate) return false;
  const sameTool = b.toolRe !== undefined ? b.toolRe.test(a.tool) : b.tool === a.tool;
  if (!sameTool) return false;
  if (b.matcher.kind === "tool") return true;
  if (b.matcher.kind === "shell" && a.matcher.kind === "shell") return b.matcher.re.test(a.matcher.text);
  if (b.matcher.kind === "domain" && a.matcher.kind === "domain")
    return b.matcher.text === "*" || b.matcher.text === a.matcher.text;
  return b.raw === a.raw && (b.baseDir === a.baseDir || !/\(\/(?!\/)/.test(b.raw));
}

function unreachable(list: readonly Rule[]): RuleIssue[] {
  const out: RuleIssue[] = [];
  for (const a of list) {
    if (a.behavior === "deny") continue;
    const b = list.find((x) => ORDER.indexOf(x.behavior) < ORDER.indexOf(a.behavior) && covers(x, a));
    if (b === undefined) continue;
    out.push({
      severity: "warning",
      message: `${a.behavior} rule ${a.raw} can never take effect: ${b.behavior} rule ${b.raw} (${where(b)}) covers it`,
      file: a.file,
      ...(a.line === undefined ? {} : { line: a.line }),
    });
  }
  return out;
}

export type Example = Record<string, string>;

/** Decides an example through the built-in checks too; undefined for a tool it does not know. */
export type ExampleDecide = (
  tool: string,
  value: string,
  cwd: string,
  mode?: string,
) => { behavior: Behavior; by: string } | undefined;

/** Checks `permissions.examples` against the rules; a mismatch names the rule that actually decides. */
export function checkExamples(
  set: RuleSet,
  examples: readonly Example[],
  opts: { cwd?: string; file?: string; decide?: ExampleDecide } = {},
): RuleIssue[] {
  const cwd = opts.cwd ?? "/";
  const issues: RuleIssue[] = [];
  for (const example of examples) {
    const tool = Object.keys(example).find((k) => k !== "expect" && k !== "mode");
    const value = tool === undefined ? undefined : example[tool];
    if (tool === undefined || value === undefined) continue;
    const decided = opts.decide?.(tool, value, cwd, example.mode);
    if (decided !== undefined) {
      if (decided.behavior !== example.expect)
        issues.push({
          severity: "error",
          file: opts.file ?? "permissions.examples",
          message: `example ${tool}: ${JSON.stringify(value)} expected ${example.expect} but is ${decided.behavior}, decided by ${decided.by}`,
        });
      continue;
    }
    const call: RuleCall = { tool, cwd };
    if (isShellTool(tool)) {
      const commands = splitCommand(value);
      if (commands !== undefined) call.commands = commands;
    } else if (tool === "Read" || tool === "Edit")
      call.paths = [{ access: tool === "Read" ? "read" : "edit", path: value }];
    else if (tool === "WebFetch") call.host = URL.canParse(value) ? new URL(value).hostname : value;
    const match = evaluateRules(set, call);
    const actual = match?.behavior ?? "ask";
    if (actual === example.expect) continue;
    issues.push({
      severity: "error",
      file: opts.file ?? "permissions.examples",
      message: `example ${tool}: ${JSON.stringify(value)} expected ${example.expect} but is ${actual}, decided by ${match === undefined ? "no rule (the default asks)" : `${match.rule} (${where(match)})`}`,
    });
  }
  return issues;
}
