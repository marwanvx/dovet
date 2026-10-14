// One decision from rules, built-in safety checks and the mode (permissions §0b, §2, §4, §5).
import { lexicalPath } from "../../platform/index.ts";
import type { PermissionMode } from "../../schema/index.ts";
import {
  type Behavior,
  evaluateRules,
  type RuleCall,
  type RuleMatch,
  type RuleSet,
  type Subcommand,
} from "../rules/index.ts";
import type { Analysis } from "../shell-parse/analyze.ts";
import { classify } from "../shell-parse/read-only.ts";
import { criticalRemoval, systemRemoval, unwrapCmd } from "./critical.ts";
import { type Env, insideWorkingDirs, protectedPath, resolveForms, sensitivePath } from "./paths.ts";
import { forcePushToDefault, remoteAction, selfControl } from "./remote.ts";
import { FS_COMMANDS, NETWORK_PATH, shellTargets, type Target, unresolvedTarget } from "./targets.ts";

export type Action =
  | { kind: "read" | "edit"; paths: string[] }
  | { kind: "shell"; analysis: Analysis; sandboxed: boolean }
  | { kind: "network"; host: string }
  | { kind: "interaction" }
  | { kind: "task-list" };

export type Request = { tool: string; action: Action; input?: Record<string, unknown> };

export type State = {
  mode: PermissionMode;
  rules: RuleSet;
  env: Env;
  sandboxAutoAllow?: boolean;
  tainted?: boolean;
  /** Besides `main` and `master`. */
  defaultBranch?: string;
  blockReadsOutsideWorkingDirectories?: boolean;
};

export type FindingKind =
  | "critical"
  | "system-removal"
  | "protected"
  | "sensitive"
  | "outside"
  | "network-path"
  | "unresolved"
  | "self"
  | "remote"
  | "force-push";

/** One thing a built-in check found; M1-23b derives `Effects` from these. */
export type Finding = {
  kind: FindingKind;
  detail: string;
  by: string;
  outcome: "ask" | "deny";
  path?: string;
  /** An explicit allow rule for this path or command lifts the prompt. */
  liftable?: boolean;
  lifted?: boolean;
  countdown?: true;
};

export type Decision = {
  behavior: Behavior;
  reason: string;
  /** Names the rule, check or mode that decided, for `permissions.examples` mismatches and the prompt. */
  by: string;
  rule?: RuleMatch;
  findings: Finding[];
  /** Bypass mode's critical-removal prompt times out and denies (§4.4). */
  countdown?: true;
};

const SECTION: Record<FindingKind, string> = {
  critical: "critical-path check (§4.4)",
  "system-removal": "system-path removal check (§4.4)",
  protected: "protected-path check (§4.3)",
  sensitive: "sensitive-file check (§4.7)",
  outside: "working-directory check (§4.1)",
  "network-path": "network-path check (§4.1)",
  unresolved: "write-target check (§4.5)",
  self: "self-protection check (§4.4b)",
  remote: "remote-action check (§4.8)",
  "force-push": "force-push check (§5)",
};
const BYPASS_SKIPS = new Set<FindingKind>(["sensitive", "outside", "unresolved", "remote"]);
const TOOL_WIDE = /^\w+(\(\s*\*?\s*\))?$/;

const finding = (
  kind: FindingKind,
  detail: string,
  outcome: Finding["outcome"],
  extra: Partial<Finding> = {},
): Finding => ({
  kind,
  detail,
  by: SECTION[kind],
  outcome,
  ...extra,
});

function expandHome(env: Env, raw: string): string {
  if (raw === "~") return env.home;
  return raw.startsWith("~/") || raw.startsWith("~\\") ? lexicalPath(raw.slice(2), env.home, env.os) : raw;
}

function pathLifted(st: State, access: "read" | "edit", path: string): boolean {
  const call: RuleCall = { tool: access === "read" ? "Read" : "Edit", cwd: st.env.cwd, paths: [{ access, path }] };
  return evaluateRules(st.rules, call)?.behavior === "allow";
}

function pathFindings(st: State, t: Target, file: boolean): Finding[] {
  const { env } = st;
  if (t.access === "edit" && env.planFile !== undefined && t.path === env.planFile) return [];
  const forms = resolveForms(env, expandHome(env, t.path), t.cwd);
  if (forms === undefined)
    return [finding("network-path", `${t.path} is a network or device path`, file ? "deny" : "ask")];
  const abs = forms.requested;
  const out: Finding[] = [];
  const both = [forms.requested, forms.canonical];
  const lifted = pathLifted(st, t.access, abs);
  const protectedHit =
    t.access === "edit" ? both.map((p) => protectedPath(p, env)).find((p) => p !== undefined) : undefined;
  if (protectedHit !== undefined)
    out.push(finding("protected", `write to a protected path: ${t.path} (${protectedHit})`, "ask", { path: abs }));
  const sensitive = both.map((p) => sensitivePath(p, env)).find((p) => p !== undefined);
  if (sensitive !== undefined)
    out.push(
      finding("sensitive", `sensitive file: ${t.path} (${sensitive})`, "ask", { path: abs, liftable: true, lifted }),
    );
  if (!insideWorkingDirs(env, forms)) {
    if (file && t.access === "read" && st.blockReadsOutsideWorkingDirectories === true)
      out.push(
        finding("outside", `outside working directory: ${t.path} (reads there are blocked)`, "deny", { path: abs }),
      );
    else
      out.push(
        finding(
          "outside",
          t.access === "edit"
            ? `write outside the project: ${t.path} (outside working directory)`
            : `outside working directory: ${t.path}`,
          "ask",
          { path: abs, liftable: true, lifted },
        ),
      );
  }
  return out;
}

function explicitAllow(st: State, tool: string, sub: Subcommand, exact: boolean): boolean {
  const m = evaluateRules(st.rules, {
    tool,
    cwd: sub.cwd ?? st.env.cwd,
    commands: [{ ...sub, readOnly: false }],
    checkable: true,
  });
  return m?.behavior === "allow" && !TOOL_WIDE.test(m.rule) && !(exact && m.rule.includes("*"));
}

function shellFindings(st: State, tool: string, a: Extract<Action, { kind: "shell" }>): Finding[] {
  const { env } = st;
  const out: Finding[] = [];
  const branches = ["main", "master", ...(st.defaultBranch === undefined ? [] : [st.defaultBranch])];
  for (const sub0 of a.analysis.commands ?? []) {
    const sub = unwrapCmd(sub0);
    const system = systemRemoval(env, sub);
    if (system !== undefined) out.push(finding("system-removal", system, "deny"));
    const critical = criticalRemoval(env, sub);
    if (critical !== undefined)
      out.push(
        finding("critical", `critical-path removal: ${critical}`, "ask", {
          ...(st.mode === "bypassPermissions" ? { countdown: true as const } : {}),
        }),
      );
    const self = selfControl(env, sub.argv);
    if (self !== undefined) out.push(finding("self", self.reason, self.behavior));
    const words = [...sub.argv.slice(1), ...(sub.redirects ?? []).map((r) => r.target)];
    const net = words.find((w) => NETWORK_PATH.test(w));
    if (net !== undefined) out.push(finding("network-path", `network path: ${net}`, "ask"));
    const tainted = st.tainted === true;
    const remote = remoteAction(sub.argv);
    if (remote !== undefined)
      out.push(
        finding(
          "remote",
          `remote action: ${remote.label}`,
          tainted ? "deny" : "ask",
          tainted ? {} : { liftable: true, lifted: explicitAllow(st, tool, sub, false) },
        ),
      );
    const force = forcePushToDefault(sub.argv, branches);
    if (force !== undefined && !explicitAllow(st, tool, sub, true))
      out.push(finding("force-push", `force-push to the default branch: ${force}`, "deny"));
    for (const t of shellTargets(sub, env.cwd)) {
      out.push(...pathFindings(st, t, false));
      if (t.access === "edit" && unresolvedTarget(t.path))
        out.push(finding("unresolved", `write target needs approval: ${t.path}`, "ask"));
    }
  }
  for (const o of a.analysis.operands) out.push(...pathFindings(st, { ...o, cwd: env.cwd }, false));
  return out;
}

function inspect(req: Request, st: State): Finding[] {
  const a = req.action;
  if (a.kind === "read" || a.kind === "edit")
    return a.paths.flatMap((path) =>
      pathFindings(st, { access: a.kind as "read" | "edit", path, cwd: st.env.cwd }, true),
    );
  return a.kind === "shell" ? shellFindings(st, req.tool, a) : [];
}

function ruleCall(req: Request, st: State): RuleCall {
  const a = req.action;
  const call: RuleCall = { tool: req.tool, cwd: st.env.cwd, ...(req.input === undefined ? {} : { input: req.input }) };
  if (a.kind === "read" || a.kind === "edit")
    call.paths = a.paths.map((path) => ({ access: a.kind as "read" | "edit", path }));
  else if (a.kind === "network") call.host = a.host;
  else if (a.kind === "shell") {
    call.checkable = a.analysis.understood;
    if (a.analysis.commands !== undefined) call.commands = a.analysis.commands;
    call.paths = [
      ...a.analysis.operands,
      ...(a.analysis.commands ?? []).flatMap((s) =>
        shellTargets(s, st.env.cwd).filter((t) => !s.redirects?.some((r) => r.target === t.path)),
      ),
    ].map(({ access, path }) => ({ access, path }));
  }
  return call;
}

function finish(
  st: State,
  d: Omit<Decision, "behavior" | "findings">,
  findings: Finding[],
  behavior: Behavior,
): Decision {
  if (behavior === "ask" && st.mode === "dontAsk")
    return { ...d, behavior: "deny", reason: `${d.reason} (dontAsk mode never prompts)`, findings };
  return { ...d, behavior, findings };
}

const readOnlyAfterRedirects = (s: Subcommand): boolean =>
  s.readOnly === true ||
  (classify(
    s.argv[0] ?? "",
    s.argv.slice(1).map((text) => ({ text, literal: true, glob: false })),
  ).ok &&
    (s.redirects ?? []).length > 0);

function shellDefault(
  st: State,
  a: Extract<Action, { kind: "shell" }>,
  match: RuleMatch | undefined,
  findings: Finding[],
): Decision {
  const { analysis } = a;
  const subs = analysis.commands;
  const done = (behavior: Behavior, reason: string, by: string): Decision =>
    finish(st, { reason, by }, findings, behavior);
  const understood = analysis.understood && subs !== undefined;
  if (st.mode === "bypassPermissions") return done("allow", "bypassPermissions mode", "the bypassPermissions mode");
  if (understood && subs.every((s) => s.readOnly === true))
    return done("allow", "read-only command", "the read-only command list (§4.6)");
  const why = understood
    ? "not a read-only command"
    : `not fully checkable: ${analysis.reasons.join("; ") || "unparsed"}`;
  if (st.mode === "plan") return done("ask", `plan mode: ${why}`, "the plan mode default");
  if (match?.behavior === "allow" && understood)
    return { ...done("allow", `allowed by ${match.rule}`, `rule ${match.rule}`), rule: match };
  const sandboxMode = st.mode === "default" || st.mode === "acceptEdits" || st.mode === "dontAsk";
  if (st.sandboxAutoAllow === true && a.sandboxed && subs !== undefined && analysis.literalNames && sandboxMode)
    return done("allow", "sandboxed command", "sandbox auto-allow (§7.3)");
  if (
    st.mode === "acceptEdits" &&
    understood &&
    subs.every(
      (s) =>
        s.readOnly === true || FS_COMMANDS.has(unwrapCmd(s).argv[0]?.toLowerCase() ?? "") || readOnlyAfterRedirects(s),
    )
  )
    return done("allow", "file edits inside the working directories", "the acceptEdits mode");
  return done("ask", why, "the Manual mode default");
}

/** Allow, ask or deny one tool call. Deny rules and hard denies win; safety asks cannot be lifted by allow rules (§5). */
export function decide(req: Request, st: State): Decision {
  const a = req.action;
  const findings = inspect(req, st);
  const call = ruleCall(req, st);
  const match = evaluateRules(st.rules, call);
  const bypass = st.mode === "bypassPermissions";
  const out = (behavior: Behavior, reason: string, by: string, extra: Partial<Decision> = {}): Decision =>
    finish(st, { reason, by, ...extra }, findings, behavior);

  if (match?.behavior === "deny") return out("deny", `denied by ${match.rule}`, `rule ${match.rule}`, { rule: match });
  const hard = findings.find((f) => f.outcome === "deny" && !f.lifted);
  if (hard !== undefined) return out("deny", hard.detail, hard.by);
  if (a.kind === "edit" && st.env.planFile !== undefined && a.paths.every((p) => p === st.env.planFile))
    return out("allow", "the plan file", "plan mode (§2)");
  if (a.kind === "edit" && st.mode === "plan")
    return out("deny", "plan mode: nothing changes until the plan is approved", "the plan mode default");

  const asks = findings.filter((f) => f.outcome === "ask" && !f.lifted && !(bypass && BYPASS_SKIPS.has(f.kind)));
  const first = asks[0];
  if (first !== undefined) {
    const countdown = asks.some((f) => f.countdown === true);
    return out("ask", first.detail, first.by, countdown ? { countdown: true } : {});
  }
  if (match?.behavior === "ask") return out("ask", `ask rule ${match.rule}`, `rule ${match.rule}`, { rule: match });

  switch (a.kind) {
    case "interaction":
      return out("ask", "needs the user's answer", "the interaction rule (§5)");
    case "task-list":
      return out("allow", "task list", "the task list");
    case "shell":
      return shellDefault(st, a, match, findings);
    case "read":
      return match?.behavior === "allow"
        ? out("allow", `allowed by ${match.rule}`, `rule ${match.rule}`, { rule: match })
        : out("allow", "read inside the working directories", "the working-directory rule (§4.1)");
    case "edit":
      if (match?.behavior === "allow")
        return out("allow", `allowed by ${match.rule}`, `rule ${match.rule}`, { rule: match });
      if (bypass || st.mode === "acceptEdits")
        return out("allow", "edit inside the working directories", `the ${st.mode} mode`);
      return out("ask", "Review edit", "the review preference (§0b)");
    case "network":
      if (match?.behavior === "allow")
        return out("allow", `allowed by ${match.rule}`, `rule ${match.rule}`, { rule: match });
      return bypass
        ? out("allow", "bypassPermissions mode", "the bypassPermissions mode")
        : out("ask", `new network host: ${a.host}`, "the network rule (§7.4)");
  }
}
