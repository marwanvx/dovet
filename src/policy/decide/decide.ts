// One decision from rules, built-in safety checks and the mode (permissions §0b, §2, §4, §5).
import { lexicalPath } from "../../platform/index.ts";
import type { PermissionMode } from "../../schema/index.ts";
import {
  type Behavior,
  commandFromInput,
  evaluateRules,
  hasDenyRule,
  PARALLEL_PROGRAMS,
  type RuleCall,
  type RuleMatch,
  type RuleSet,
  type Subcommand,
  shellScriptAt,
  unwrapCommand,
  xargsCommandStarts,
} from "../rules/index.ts";
import { shouldRefuseLocalHost } from "../sandbox/network.ts";
import type { Analysis } from "../shell-parse/analyze.ts";
import { classify } from "../shell-parse/read-only.ts";
import { cmdOperandUnsafe, criticalRemoval, systemRemoval, unwrapCmd } from "./critical.ts";
import {
  type Env,
  insideWorkingDirs,
  protectedDirAbove,
  protectedName,
  protectedPath,
  resolveForms,
  sensitiveName,
  sensitivePath,
} from "./paths.ts";
import { forcePushWithInput, program, type RemoteKind, remoteWithInput, selfControl } from "./remote.ts";
import {
  type FindDeletion,
  FS_COMMANDS,
  findDeletions,
  findStarts,
  NETWORK_PATH,
  parallelRuns,
  sedEscapes,
  shellTargets,
  type Target,
  unresolvedTarget,
  XARGS_INPUT,
  xargsRuns,
} from "./targets.ts";

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
  /** Where the taint came from, for the `session tainted by <source>` banner (permissions §10). */
  taintSource?: string;
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
  | "force-push"
  | "unchecked"
  | "computed";

/** One thing a built-in check found; M1-23b derives `Effects` from these. */
export type Finding = {
  kind: FindingKind;
  detail: string;
  by: string;
  outcome: "ask" | "deny";
  path?: string;
  access?: "read" | "edit";
  remote?: RemoteKind;
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
  unchecked: "wrapper reading (§3.2)",
  computed: "xargs input check (§4.4)",
};
const BYPASS_SKIPS = new Set<FindingKind>(["sensitive", "outside", "unresolved", "remote", "computed"]);
const TOOL_WIDE = /^\w+(\(\s*\*?\s*\))?$/;
const PATH_GLOB = /[*?[]/;
const CMD_OPAQUE = "a cmd /c layer can't be fully checked";
const CMD_OPAQUE_SHELL = "a cmd /c layer hides the shell script it runs";
const CMD_OPAQUE_LAUNCH = "a cmd /c layer starts a command it doesn't show";
// What cmd runs through these isn't the argv the checks read (QUESTIONS Q111).
const CMD_LAUNCHERS = new Set(["start", "wsl", "schtasks", "pwsh", "pwsh-preview", "powershell", "powershell_ise"]);

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

function pathLifted(st: State, access: "read" | "edit", path: string, exact = false): boolean {
  const call: RuleCall = { tool: access === "read" ? "Read" : "Edit", cwd: st.env.cwd, paths: [{ access, path }] };
  const m = evaluateRules(st.rules, call);
  return m?.behavior === "allow" && (!exact || (!TOOL_WIDE.test(m.rule) && !/[*?[{]/.test(m.rule)));
}

function pathFindings(st: State, t: Target, file: boolean, sandboxedRead = false): Finding[] {
  const { env } = st;
  const forms = resolveForms(env, expandHome(env, t.path), t.cwd);
  if (forms === undefined)
    return [finding("network-path", `${t.path} is a network or device path`, file ? "deny" : "ask")];
  const abs = forms.requested;
  const out: Finding[] = [];
  const both = [forms.requested, forms.canonical];
  const lifted = pathLifted(st, t.access, abs);
  const sensitiveLifted = pathLifted(st, t.access, abs, true);
  const protectedHit =
    t.access === "edit" ? both.map((p) => protectedPath(p, env)).find((p) => p !== undefined) : undefined;
  if (protectedHit !== undefined)
    out.push(finding("protected", `write to a protected path: ${t.path} (${protectedHit})`, "ask", { path: abs }));
  const sensitive = both.map((p) => sensitivePath(p, env)).find((p) => p !== undefined);
  if (sensitive !== undefined) {
    const banner = st.tainted === true ? `session tainted by ${st.taintSource ?? "untrusted input"}: ` : "";
    out.push(
      finding("sensitive", `${banner}sensitive file: ${t.path} (${sensitive})`, "ask", {
        path: abs,
        liftable: true,
        lifted: st.tainted === true ? false : sensitiveLifted,
      }),
    );
  }
  // The plan file may live in the session's folder under the data dir; every other check still runs on it.
  const planFile = file && env.planFile !== undefined && t.path === env.planFile;
  if (!insideWorkingDirs(env, forms) && !(sandboxedRead && t.access === "read") && !planFile) {
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
  return out.map((f) => (f.path === undefined ? f : { ...f, access: t.access }));
}

/** An allow rule that names the command: no wildcard, or at least two fixed words before it (`git push*`, not `git *`). */
function namesCommand(rule: string, label?: string): boolean {
  if (TOOL_WIDE.test(rule)) return false;
  const text = rule.slice(rule.indexOf("(") + 1, rule.lastIndexOf(")"));
  const star = text.indexOf("*");
  if (star < 0) return true;
  const prefix = text.slice(0, star).trim().split(/\s+/);
  const verb = label?.split(" ")[1];
  const named = verb === undefined || ["upload", "to"].includes(verb) || prefix.includes(verb);
  return prefix.length >= 2 && named;
}

function explicitAllow(st: State, tool: string, sub: Subcommand, exact: boolean, label?: string): boolean {
  const m = evaluateRules(st.rules, {
    tool,
    cwd: sub.cwd ?? st.env.cwd,
    commands: [{ ...sub, readOnly: false }],
    checkable: true,
  });
  return m?.behavior === "allow" && namesCommand(m.rule, label) && !(exact && m.rule.includes("*"));
}

const MAX_VARIANT_WORDS = 2_000_000;

// The plain form of a `parallel`/`sem` command is the only one whose arguments stay where they are typed: options only
// `-k`/`-j` (`--keep-order`, `--jobs`), no `{= perl =}` replacement, and no `PARALLEL`/`PARALLEL_HOME` set in the script —
// parallel reads options from that variable and from `$PARALLEL_HOME/config`, and `{= =}` computes any word (QUESTIONS Q97).
const PLAIN_PARALLEL_OPTION = /^(-k|-j\S*|--keep-order|--jobs(=\S*)?)$/;

/**
 * Why a `parallel`/`sem` command this reading could run can't be followed (its arguments can be placed anywhere), or
 * undefined when every one it runs is plain. The env checks reach readings that name parallel among their words
 * (`env -S 'PARALLEL=-i parallel …'`), not only parallel-headed ones. A word holding `PARALLEL` counts whatever it
 * holds it for, since bash builds the assignment without a `PARALLEL=`-shaped word (`printf -v PARALLEL …`,
 * `env ${X:+PARALLEL=-i} …`); a command-substitution word counts because it can assemble the assignment from pieces
 * (`env "$(printf %s PAR ALLEL)=-iXX" …`).
 */
function parallelOddity(v: string[], scriptSetsParallelEnv: boolean): string | undefined {
  if (!v.some((w) => PARALLEL_PROGRAMS.has(program(w)))) return undefined;
  if (v.some((w) => w.includes("PARALLEL")) || scriptSetsParallelEnv)
    return "a word of the script holds PARALLEL, and parallel reads its options from that variable, so what runs can't be checked";
  if (v.some((w) => w.includes("$(") || w.includes("`")))
    return "a command substitution in the script could hand parallel its options, so what runs can't be checked";
  if (!PARALLEL_PROGRAMS.has(program(v[0]))) return undefined;
  const { starts } = xargsCommandStarts(v);
  const end = starts.length === 0 ? v.length : Math.max(...starts);
  const odd = v.slice(1, end).find((w) => w.startsWith("-") && w !== "-" && !PLAIN_PARALLEL_OPTION.test(w));
  if (odd !== undefined)
    return `parallel's option ${odd} can place its arguments anywhere, so what runs can't be checked`;
  const perl = v.find((w) => w.includes("{="));
  if (perl !== undefined)
    return `parallel's {= perl =} replacement ${perl} computes any word, so what runs can't be checked`;
  return undefined;
}

/** A run of bare `xargs` words led by `xargs` itself is one re-invocation: the chain's command and arguments carry the stand-in. */
function collapseXargs(argv: string[]): string[] {
  if (program(argv[0]) !== "xargs") return argv;
  let j = 1;
  while (j < argv.length && program(argv[j]) === "xargs") j++;
  return j > 1 && j < argv.length ? [argv[0] ?? "", ...argv.slice(j)] : argv;
}

/**
 * The command and itself with each wrapper (`sudo`, `env`, `exec`, `busybox`) stripped off the front, and what xargs
 * and parallel run with their input in place; `complete` is false when not every reading was looked at.
 */
function variants(argv: string[]): { all: string[][]; complete: boolean } {
  const out: string[][] = [];
  const seen = new Set<string>();
  const queue = [argv];
  let complete = true;
  let words = 0;
  for (let a = queue.pop(); a !== undefined && complete; a = queue.pop()) {
    a = collapseXargs(a);
    const unwrapped = unwrapCommand(a);
    complete &&= unwrapped.complete;
    for (const v of unwrapped.argvs) {
      const key = v.join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
      words += v.length;
      if (words > MAX_VARIANT_WORDS) complete = false;
      // Each xargs is expanded once: a chain re-expanding its own stand-in readings is what xargs runs anyway.
      if (program(v[0]) === "xargs" && !v.includes(XARGS_INPUT)) queue.push(...xargsRuns(v));
      if (program(v[0]) === "parallel" && !v.includes(XARGS_INPUT)) queue.push(...parallelRuns(v));
    }
  }
  return { all: out, complete };
}

/** A find action whose tests name no file leaves its whole reach asking; an exact allow rule naming the command
 * lifts that ask, as the compatibility corpus requires. */
function unnamedReach(st: State, tool: string, typed: Subcommand, del: FindDeletion): Finding {
  return {
    ...finding(
      "sensitive",
      `sensitive file: ${del.cmd.join(" ")} — no test before the action names what find deletes`,
      "ask",
    ),
    lifted: explicitAllow(st, tool, typed, true),
  };
}

/** A find action deletes what the narrowing tests before it name: their values are matched against the sensitive and
 * protected names, and tests that name no file leave the whole reach asking (§4.4 Q93, §4.3, §4.7). */
function findReachFindings(
  st: State,
  tool: string,
  typed: Subcommand,
  del: FindDeletion,
  cwd: string,
  sandboxedRead: boolean,
): Finding[] {
  const ns = del.narrowings;
  if (ns === undefined) return [unnamedReach(st, tool, typed, del)];
  const out: Finding[] = [];
  for (const n of ns) {
    if (n.kind === "file") {
      out.push(...pathFindings(st, { access: "edit", path: n.value, cwd }, false, sandboxedRead));
      continue;
    }
    if (n.kind === "regex") {
      out.push(finding("sensitive", "sensitive file: find's -regex test could name one", "ask"));
      continue;
    }
    const value = n.value.slice(Math.max(n.value.lastIndexOf("/"), n.value.lastIndexOf("\\")) + 1);
    if (value === "" || value === "." || value === "..") {
      out.push(unnamedReach(st, tool, typed, del));
      continue;
    }
    // A literal -path value is a concrete path: it gets the full checks a start path gets; a case-insensitive
    // test falls through to the name checks, which fold (`./.GITCONFIG` on Linux).
    if (n.kind === "path" && !PATH_GLOB.test(n.value)) {
      out.push(...pathFindings(st, { access: "edit", path: n.value, cwd }, false, sandboxedRead));
      if (!n.fold) continue;
    }
    const sensitive = sensitiveName(value, st.env, n.fold);
    if (sensitive !== undefined) {
      const banner = st.tainted === true ? `session tainted by ${st.taintSource ?? "untrusted input"}: ` : "";
      out.push(
        finding(
          "sensitive",
          `${banner}sensitive file: find could delete a file named ${n.value} (${sensitive})`,
          "ask",
        ),
      );
      continue;
    }
    const hit = protectedName(value, st.env, n.fold);
    if (hit !== undefined)
      out.push(
        finding("protected", `write to a protected path: find could delete a file named ${n.value} (${hit})`, "ask"),
      );
  }
  return out;
}

function shellFindings(st: State, tool: string, a: Extract<Action, { kind: "shell" }>): Finding[] {
  const { env } = st;
  const out: Finding[] = [];
  const branches = ["main", "master", ...(st.defaultBranch === undefined ? [] : [st.defaultBranch])];
  const sandboxedRead = st.sandboxAutoAllow === true && a.sandboxed;
  const subs = [...(a.analysis.commands ?? []), ...(a.analysis.recovered?.commands ?? [])];
  // A `PARALLEL`/`PARALLEL_HOME` assignment anywhere in the script reaches every parallel in it, so none of them is
  // plain while it stands (`export PARALLEL=-i; parallel …`, `env PARALLEL=-i parallel …`). Any word holding
  // `PARALLEL` counts: bash builds the assignment without a `PARALLEL=`-shaped word (`printf -v PARALLEL …`).
  const scriptSetsParallelEnv =
    subs.some((s) => s.argv.some((w) => w.includes("PARALLEL"))) &&
    subs.some((s) => s.argv.some((w) => PARALLEL_PROGRAMS.has(program(w))));
  for (const sub0 of subs) {
    const unwrapped = unwrapCmd(sub0);
    const viaCmd = unwrapped !== sub0;
    const { all, complete } = variants(unwrapped.argv);
    let fullyRead = complete;
    if (viaCmd && cmdOperandUnsafe(sub0.argv)) out.push(finding("unchecked", CMD_OPAQUE, "ask"));
    // Every reading the command could run, in one worklist: a `cmd /c` layer below a wrapper peels into its
    // operand reading, which re-enters the reader (find -exec, xargs and wrappers below the layer expand — F59).
    // `via` rides along: what runs via cmd makes cmd's own rd/del/erase removers (§4.4).
    const queue: { argv: string[]; via: boolean }[] = [];
    const seen = new Set<string>();
    const push = (argv: string[], via: boolean): void => {
      const key = argv.join("\0");
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ argv, via });
      }
    };
    for (const v of all) push(v, viaCmd);
    for (const { argv: v, via } of queue) {
      if (program(v[0]) === "cmd") {
        if (cmdOperandUnsafe(v)) {
          out.push(finding("unchecked", CMD_OPAQUE, "ask"));
          continue;
        }
        const sub = unwrapCmd({ ...unwrapped, argv: [program(v[0]), ...v.slice(1)] });
        if (sub.argv.join("\0") !== v.join("\0")) {
          const deeper = variants(sub.argv);
          fullyRead &&= deeper.complete;
          for (const w of deeper.all) push(w, true);
          continue;
        }
      }
      const sub = unwrapCmd({ ...unwrapped, argv: [program(v[0]), ...v.slice(1)] });
      if (via && SHELL_COMMANDS.has(program(v[0]))) out.push(finding("unchecked", CMD_OPAQUE_SHELL, "ask"));
      if (via && CMD_LAUNCHERS.has(program(v[0]))) out.push(finding("unchecked", CMD_OPAQUE_LAUNCH, "ask"));
      const system = systemRemoval(env, sub, via);
      if (system !== undefined) out.push(finding("system-removal", system, "deny"));
      const critical = criticalRemoval(env, sub);
      if (critical !== undefined)
        out.push(
          finding("critical", `critical-path removal: ${critical}`, "ask", {
            ...(st.mode === "bypassPermissions" ? { countdown: true as const } : {}),
          }),
        );
      const cwd = sub.cwd ?? env.cwd;
      if (program(sub.argv[0]) === "find") {
        const dels = findDeletions(sub.argv);
        const above =
          dels.length > 0
            ? findStarts(sub.argv)
                .map((s) => protectedDirAbove(s, env))
                .find((d) => d !== undefined)
            : undefined;
        if (above !== undefined)
          out.push(
            finding("protected", `write to a protected path: find could reach ${above} under its start path`, "ask"),
          );
        for (const del of dels) {
          const why = criticalRemoval(env, unwrapCmd({ ...sub, argv: del.cmd }));
          if (why !== undefined)
            out.push(
              finding("critical", `critical-path removal: find ${why}`, "ask", {
                ...(st.mode === "bypassPermissions" ? { countdown: true as const } : {}),
              }),
            );
          out.push(...findReachFindings(st, tool, unwrapped, del, cwd, sandboxedRead));
        }
      }
      // The input can name the command itself (a chain of xargs, a wrapper whose operand or `/c` the input
      // completes) or bring `find` its `-delete`: what runs can be a recursive removal of any path, so the
      // typed words alone can't clear it. `cmd /c` peeling moves the program, so the peeled words are read too.
      const names = [program(v[0]), program(sub.argv[0])];
      if (
        v.includes(XARGS_INPUT) &&
        (names.includes(XARGS_INPUT) ||
          names.some((n) => n === "find" || n === "xargs") ||
          (program(v[0]) === "cmd" && program(sub.argv[0]) === "cmd") ||
          commandFromInput(v, XARGS_INPUT) ||
          commandFromInput(sub.argv, XARGS_INPUT))
      )
        out.push(
          finding("critical", "critical-path removal: what xargs reads from its input can be one of any path", "ask", {
            ...(st.mode === "bypassPermissions" ? { countdown: true as const } : {}),
          }),
        );
      const odd = parallelOddity(v, scriptSetsParallelEnv);
      if (odd !== undefined) out.push(finding("unchecked", odd, "ask"));
      const self = selfControl(env, sub.argv);
      if (self !== undefined) out.push(finding("self", self.reason, self.behavior));
      const deletes = program(sub.argv[0]) === "find" && sub.argv.includes("-delete") ? findStarts(sub.argv) : [];
      for (const t of [
        ...shellTargets(sub, env.cwd),
        ...deletes.map((path): Target => ({ access: "edit", path, cwd })),
      ]) {
        out.push(...pathFindings(st, t, false, sandboxedRead));
        if (t.access === "edit" && unresolvedTarget(t.path))
          out.push(finding("unresolved", `write target needs approval: ${t.path}`, "ask"));
        else if (t.access === "read" && DYNAMIC_WORD.test(t.path) && !sandboxedRead)
          out.push(finding("unresolved", `read target needs approval: ${t.path}`, "ask"));
      }
      if (v.includes(XARGS_INPUT) && !sandboxedRead)
        out.push(
          finding(
            "computed",
            `xargs passes its input to ${
              sub.argv[0] === XARGS_INPUT ? "a command named by that input" : sub.argv[0]
            }, so its files can't be checked`,
            "ask",
          ),
        );
    }
    const words = [...sub0.argv.slice(1), ...(sub0.redirects ?? []).map((r) => r.target)];
    const net = words.find((w) => NETWORK_PATH.test(w));
    if (net !== undefined) out.push(finding("network-path", `network path: ${net}`, "ask"));
    if (!fullyRead) out.push(finding("unchecked", "a wrapper's options can't all be checked", "ask"));
    const sub = { ...unwrapped };
    const readings = queue.map((r) => r.argv);
    const remote = readings.map((v) => remoteWithInput(v, XARGS_INPUT, sub0.literalWords)).find((r) => r !== undefined);
    if (remote !== undefined)
      out.push(
        finding(
          "remote",
          `remote action: ${remote.label}`,
          st.tainted === true ? "deny" : "ask",
          st.tainted === true
            ? { remote: remote.kind }
            : { remote: remote.kind, liftable: true, lifted: explicitAllow(st, tool, sub, false, remote.label) },
        ),
      );
    const force = readings.map((v) => forcePushWithInput(v, XARGS_INPUT, branches)).find((f) => f !== undefined);
    if (force !== undefined && !explicitAllow(st, tool, sub, true))
      out.push(finding("force-push", `force-push to the default branch: ${force}`, "deny"));
  }
  for (const o of [...a.analysis.operands, ...(a.analysis.recovered?.operands ?? [])])
    out.push(...pathFindings(st, { ...o, cwd: env.cwd }, false, sandboxedRead));
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
    // Recovered commands match deny and ask rules but never allow ones: checkable stays false on a syntax error.
    if (a.analysis.commands !== undefined) call.commands = a.analysis.commands;
    else if (a.analysis.recovered !== undefined) call.commands = a.analysis.recovered.commands;
    call.paths = [
      ...a.analysis.operands,
      ...(a.analysis.recovered?.operands ?? []),
      ...[...(a.analysis.commands ?? []), ...(a.analysis.recovered?.commands ?? [])].flatMap((s) =>
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

function fsCommand(s: Subcommand): boolean {
  const { argv } = unwrapCmd(s);
  const name = program(argv[0]);
  return FS_COMMANDS.has(name) && !(name === "sed" && sedEscapes(argv.slice(1)));
}

/** Command names that always need a prompt, even under sandbox auto-allow (permissions §4.0 item 1). */
const DYNAMIC_NAMES = new Set(["eval", "source", ".", "exec", "coproc", "invoke-expression"]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const DYNAMIC_WORD = /[$`]/;

function isDynamicVariant(v: string[]): boolean {
  const raw = v[0] ?? "";
  if (raw === "" || DYNAMIC_WORD.test(raw)) return true;
  const name = program(raw);
  if (DYNAMIC_NAMES.has(name)) return true;
  if (name === "xargs") {
    const { starts, none } = xargsCommandStarts(v);
    if (none || starts.some((i) => DYNAMIC_WORD.test(v[i] ?? ""))) return true;
  }
  if (SHELL_COMMANDS.has(name)) {
    const at = shellScriptAt(v.slice(1));
    const script = at < 0 ? undefined : v[at + 1];
    if (script === undefined || DYNAMIC_WORD.test(script)) return true;
  }
  return false;
}

function hasDynamicName(subs: Subcommand[]): boolean {
  return subs.some((s) => variants(unwrapCmd(s).argv).all.some(isDynamicVariant));
}

function shellDefault(
  st: State,
  tool: string,
  a: Extract<Action, { kind: "shell" }>,
  match: RuleMatch | undefined,
  findings: Finding[],
): Decision {
  const { analysis } = a;
  const subs = analysis.commands;
  const done = (behavior: Behavior, reason: string, by: string): Decision =>
    finish(st, { reason, by }, findings, behavior);
  const understood = analysis.understood && subs !== undefined;
  if (st.mode === "bypassPermissions") {
    // An unparsed analysis yields no findings, so every check was skipped: bypass asks instead of allowing (§4.0 item 7).
    if (subs === undefined)
      return done("ask", `not fully checkable: ${analysis.reasons.join("; ") || "unparsed"}`, "the analyzer (§4.0)");
    // The part the analysis can't see may be what the taint or a deny rule exists to stop (§4.0 item 10).
    if (!understood && st.tainted === true)
      return done(
        "ask",
        `session tainted by ${st.taintSource ?? "untrusted input"}: not fully checkable: ${analysis.reasons.join("; ")}`,
        "the bypass rule for unreadable commands (§4.0 item 10)",
      );
    // Its file operands are checked against Read and Edit deny rules too (item 4).
    if (!understood && hasDenyRule(st.rules, [tool, "Read", "Edit"]))
      return done(
        "ask",
        `not fully checkable: ${analysis.reasons.join("; ")} (a deny rule could apply)`,
        "the bypass rule for unreadable commands (§4.0 item 10)",
      );
    return done("allow", "bypassPermissions mode", "the bypassPermissions mode");
  }
  if (understood && subs.every((s) => s.readOnly === true))
    return done("allow", "read-only command", "the read-only command list (§4.6)");
  const why = understood
    ? "not a read-only command"
    : `not fully checkable: ${analysis.reasons.join("; ") || "unparsed"}`;
  if (st.mode === "plan") return done("ask", `plan mode: ${why}`, "the plan mode default");
  if (match?.behavior === "allow" && understood)
    return { ...done("allow", `allowed by ${match.rule}`, `rule ${match.rule}`), rule: match };
  const sandboxMode = st.mode === "default" || st.mode === "acceptEdits" || st.mode === "dontAsk";
  const taintedHold = st.tainted === true;
  const dynamicHold = subs !== undefined && hasDynamicName(subs);
  if (
    st.sandboxAutoAllow === true &&
    a.sandboxed &&
    subs !== undefined &&
    analysis.literalNames &&
    sandboxMode &&
    !taintedHold &&
    !dynamicHold
  )
    return done("allow", "sandboxed command", "sandbox auto-allow (§7.3)");
  if (
    st.mode === "acceptEdits" &&
    understood &&
    subs.every((s) => s.readOnly === true || fsCommand(s) || readOnlyAfterRedirects(s))
  )
    return done("allow", "file edits inside the working directories", "the acceptEdits mode");
  if (!a.sandboxed)
    return done("ask", `unsandboxed command: ${why} (unsandboxed execution, §7.5)`, "the Manual mode default");
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
  const asks = findings.filter((f) => f.outcome === "ask" && !f.lifted && !(bypass && BYPASS_SKIPS.has(f.kind)));
  if (
    a.kind === "edit" &&
    asks.length === 0 &&
    match?.behavior !== "ask" &&
    st.env.planFile !== undefined &&
    a.paths.length > 0 &&
    a.paths.every((p) => p === st.env.planFile)
  )
    return out("allow", "the plan file", "plan mode (§2)");
  if (a.kind === "edit" && st.mode === "plan")
    return out("deny", "plan mode: nothing changes until the plan is approved", "the plan mode default");

  const first = asks[0];
  if (first !== undefined) {
    const countdown = asks.some((f) => f.countdown === true);
    return out("ask", first.detail, first.by, countdown ? { countdown: true } : {});
  }
  if (match?.behavior === "ask") {
    const bareSkipped =
      a.kind === "shell" &&
      a.sandboxed &&
      st.sandboxAutoAllow === true &&
      st.mode !== "plan" &&
      TOOL_WIDE.test(match.rule);
    if (!bareSkipped) return out("ask", `ask rule ${match.rule}`, `rule ${match.rule}`, { rule: match });
  }

  switch (a.kind) {
    case "interaction":
      return out("ask", "needs the user's answer", "the interaction rule (§5)");
    case "task-list":
      return out("allow", "task list", "the task list");
    case "shell":
      return shellDefault(st, req.tool, a, match, findings);
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
      if (shouldRefuseLocalHost(a.host))
        return out("deny", `refused local address: ${a.host}`, "the local-address rule (§7.4)");
      return bypass
        ? out("allow", "bypassPermissions mode", "the bypassPermissions mode")
        : out("ask", `new network host: ${a.host}`, "the network rule (§7.4)");
  }
}

/** What leaving plan mode offers: the mode active before plan first, never a lower one (§2). */
export function planExitChoices(before: PermissionMode): PermissionMode[] {
  const order: PermissionMode[] = ["default", "acceptEdits"];
  return [...new Set<PermissionMode>([before === "plan" ? "default" : before, ...order])];
}
