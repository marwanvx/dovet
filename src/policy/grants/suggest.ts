import { posix, win32 } from "node:path";
import { isWithin } from "../../platform/index.ts";
import { type Decision, decide, type Request, type State } from "../decide/index.ts";
import {
  allowRuleArgv,
  escapeLiteral,
  evaluateRules,
  loadRules,
  needsExactRule,
  type Subcommand,
  toPosix,
} from "../rules/index.ts";

/** What "Yes, and don't ask again" would save (permissions §1, §6); `session` rules are held by the agent, never written. */
export type Grant = { scope: "permanent" | "session"; rules: string[] };

const MAX_SHELL_RULES = 5;
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Zs}]/u;
const hidden = (text: string): boolean => INVISIBLE.test(text.replaceAll(" ", ""));
const NON_ASCII = /[^ -~]/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/** Programs whose first word is a verb; the rule keeps both (`npm run *`, `git commit *`). */
const VERBS = new Set([
  "git",
  "gh",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "tofu",
  "pulumi",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "dotnet",
  "make",
  "deno",
  "rustup",
  "brew",
  "apt",
  "apt-get",
]);
/** Programs a `prog *` rule would hand over entirely, or that destroy: only the exact command may be saved. */
const EXACT_ONLY = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "pwsh",
  "powershell",
  "cmd",
  "env",
  "sudo",
  "doas",
  "xargs",
  "eval",
  "exec",
  "time",
  "nohup",
  "watch",
  "ssh",
  "su",
  "rm",
  "rmdir",
  "mv",
  "dd",
  "chmod",
  "chown",
  "kill",
  "pkill",
  "killall",
  "timeout",
  "nice",
  "stdbuf",
  "command",
  "builtin",
  "noglob",
  "node",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "lua",
  "npx",
  "bunx",
  "pnpx",
  "curl",
  "wget",
  "http",
  "nc",
  "ncat",
  "shred",
  "truncate",
  "mkfs",
  "ln",
  "source",
  ".",
]);

/** Verbs that run whatever comes next, so only the exact command may be saved. */
const RUNNING_VERBS: Record<string, readonly string[]> = {
  npm: ["exec", "x"],
  pnpm: ["exec", "dlx"],
  yarn: ["dlx", "exec"],
  bun: ["x"],
  go: ["run"],
  cargo: ["run"],
  uv: ["run", "tool"],
  poetry: ["run"],
  deno: ["run"],
  dotnet: ["run"],
  docker: ["run", "exec"],
  podman: ["run", "exec"],
  kubectl: ["exec", "run"],
  gh: ["api"],
};

const program = (argv0: string | undefined): string =>
  (argv0 ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();

function shellRule(tool: string, called: Subcommand): string | undefined {
  const argv = allowRuleArgv(called.argv);
  const [first = "", second] = argv;
  if (first === "" || NON_ASCII.test(first) || argv.some((w) => w.includes("*"))) return undefined;
  const name = program(first);
  const exact = () => (argv.some((w) => /\s/.test(w)) ? undefined : `${tool}(${argv.join(" ")})`);
  if (needsExactRule(argv) || EXACT_ONLY.has(name) || /[\\/]/.test(first) || argv.length === 1) return exact();
  if (VERBS.has(name)) {
    if (second?.startsWith("-") || RUNNING_VERBS[name]?.includes(second ?? "")) return exact();
    return `${tool}(${first} ${second} *)`;
  }
  return `${tool}(${first} *)`;
}

/** The rules lift the prompt for the call they were made from, tested through the full decision (permissions §6 "Saved rules must round-trip"). */
function roundTrips(req: Request, st: State, rules: string[]): boolean {
  const { rules: made } = loadRules(
    [{ file: "(grant)", baseDir: st.env.cwd, allow: rules.map((text) => ({ text })) }],
    st.rules.ctx,
  );
  return decide(req, { ...st, rules: { ...st.rules, list: [...st.rules.list, ...made.list] } }).behavior === "allow";
}

function shellGrant(req: Request, d: Decision, st: State): Grant | undefined {
  if (req.action.kind !== "shell") return undefined;
  const { analysis } = req.action;
  const subs = analysis.commands;
  if (!analysis.understood || subs === undefined) return undefined;
  if (d.findings.some((f) => f.outcome === "ask" && !f.lifted && !(f.kind === "remote" && f.liftable === true)))
    return undefined;
  const needed = subs.filter(
    (sub) =>
      sub.readOnly !== true &&
      evaluateRules(st.rules, { tool: req.tool, cwd: sub.cwd ?? st.env.cwd, commands: [sub], checkable: true })
        ?.behavior !== "allow",
  );
  if (needed.length === 0 || needed.length > MAX_SHELL_RULES) return undefined;
  if (needed.some((sub) => sub.argv.some((w) => hidden(w)))) return undefined;
  if (subs.flatMap((s) => s.redirects ?? []).some((r) => hidden(r.target))) return undefined;
  const rules: string[] = [];
  for (const sub of needed) {
    const rule = shellRule(req.tool, sub);
    if (rule === undefined) return undefined;
    if (!rules.includes(rule)) rules.push(rule);
  }
  return roundTrips(req, st, rules) ? { scope: "permanent", rules } : undefined;
}

const dirname = (st: State, path: string): string => (st.env.os === "win32" ? win32 : posix).dirname(path);
const isUnder = (st: State, dir: string, path: string): boolean => isWithin(path, dir, st.env.os);
const absRule = (st: State, path: string): string => `/${toPosix(path, st.env.os)}`;
const exactRule = (st: State, tool: "Read" | "Edit", path: string): string =>
  `${tool}(${escapeLiteral(absRule(st, path))})`;

function fileGrant(req: Request, d: Decision, st: State): Grant | undefined {
  const a = req.action;
  if (a.kind !== "read" && a.kind !== "edit") return undefined;
  if (d.rule?.behavior === "ask") return undefined;
  const tool = a.kind === "read" ? "Read" : "Edit";
  const asks = d.findings.filter((f) => f.outcome === "ask" && !f.lifted);
  if (asks.some((f) => f.liftable !== true || f.path === undefined)) return undefined;
  if (a.paths.length > MAX_SHELL_RULES || a.paths.some((p) => hidden(p))) return undefined;
  if (asks.length === 0) {
    if (a.kind === "read") return undefined;
    const dirs = a.paths.map((p) => st.env.workingDirs.find((w) => isUnder(st, w, p)));
    if (dirs.some((w) => w === undefined)) return undefined;
    const rules = [...new Set(dirs.map((w) => `Edit(${escapeLiteral(absRule(st, w ?? ""))}/**)`))];
    return { scope: "session", rules };
  }
  if (st.tainted === true && asks.some((f) => f.kind === "sensitive")) return undefined;
  const rules = [
    ...new Set(
      asks.map((f) => {
        const path = f.path ?? "";
        const dir = dirname(st, path);
        if (f.kind === "outside" && a.kind === "read" && dir !== dirname(st, dir) && dir !== st.env.home)
          return `Read(${escapeLiteral(absRule(st, dir))}/**)`;
        return exactRule(st, tool, path);
      }),
    ),
  ];
  return { scope: a.kind === "read" ? "permanent" : "session", rules };
}

/** The rules "Yes, and don't ask again" would save for a prompted call, or undefined when only one-time approval is safe. */
export function suggestGrant(req: Request, decision: Decision, st: State): Grant | undefined {
  if (decision.behavior !== "ask") return undefined;
  const a = req.action;
  switch (a.kind) {
    case "shell":
      return shellGrant(req, decision, st);
    case "read":
    case "edit":
      return fileGrant(req, decision, st);
    case "network":
      if (st.tainted === true || decision.rule?.behavior === "ask") return undefined;
      if (req.tool === "WebSearch") return { scope: "permanent", rules: ["WebSearch"] };
      return HOST.test(a.host)
        ? { scope: "permanent", rules: [`WebFetch(domain:${a.host.toLowerCase()})`] }
        : undefined;
    default:
      return undefined;
  }
}
