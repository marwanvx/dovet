// Remote actions (permissions §4.8) and self-protection (§4.4b), recognized from the analyzer's argv.
import { commandName } from "../rules/index.ts";
import type { Env } from "./paths.ts";

export const REMOTE_VERSION = 1;

export type RemoteKind = "push" | "publish" | "upload" | "deploy";
type Remote = { kind: RemoteKind; label: string };

const GIT_OPTION_VALUES = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--attr-source",
]);

/** `git -C dir -c k=v push …` → `["push", …]`. */
function gitArgs(args: string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (GIT_OPTION_VALUES.has(a)) i++;
    else if (!a.startsWith("-")) return args.slice(i);
  }
  return [];
}

export const program = commandName;

const positional = (args: string[]): string[] => args.filter((a) => !a.startsWith("-"));
const curlUpload = (args: string[]): boolean =>
  args.some(
    (a, i) =>
      /^--(data|form|json|upload-file)/.test(a) ||
      /^-[A-Za-z]*[dFT]/.test(a) ||
      /^-[A-Za-z]*X\s*(POST|PUT|PATCH|DELETE)$/i.test(a) ||
      (/^-[A-Za-z]*X$/.test(a) && /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? "")) ||
      /^--request=(POST|PUT|PATCH|DELETE)$/i.test(a) ||
      ((a === "-X" || a === "--request") && /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? "")),
  );
const ghApiWrites = (args: string[]): boolean =>
  args.some(
    (a, i) =>
      /^(-f|-F|--field|--raw-field|--input)$/.test(a) ||
      /^-[fF].|^--(field|raw-field|input)=/.test(a) ||
      ((a === "-X" || a === "--method") && !/^GET$/i.test(args[i + 1] ?? "")) ||
      (/^-X./.test(a) && !/^-XGET$/i.test(a)) ||
      (/^--method=/.test(a) && !/^GET$/i.test(a.slice(9))),
  );
const REMOTE_TARGET = /^(?:[\w.-]+@)?[\w.-]{2,}:|^rsync:\/\//;

const GH_WRITES: Array<[string, string[]]> = [
  ["pr", ["create", "merge", "comment", "review"]],
  ["issue", ["create", "comment"]],
  ["release", ["create"]],
  ["repo", ["create", "delete"]],
  ["gist", ["create"]],
  ["workflow", ["run"]],
];

/** Words that make a command of the table below a remote action, tried where a word only known at run time goes. */
const REMOTE_WORDS: string[][] = [
  ...["push", "send-email", "request-pull", "publish", "upload", "deploy", "apply", "destroy", "up"].map((w) => [w]),
  ...["delete", "patch", "install", "upgrade", "uninstall"].map((w) => [w]),
  ["nuget", "push"],
  ...GH_WRITES.flatMap(([g, hs]) => hs.flatMap((h) => [[g, h], [h]])),
  ["api", "-X", "POST"],
  ["-X", "POST"],
  ["-d", "x"],
  ["--post-data=x"],
  ["host:x"],
];

/** The remote action a command could be once each `input` word is filled in at run time (xargs input), else undefined. */
export function remoteWithInput(argv: string[], input: string): Remote | undefined {
  const at = argv.flatMap((w, i) => (w === input ? [i] : []));
  if (at.length === 0) return remoteAction(argv);
  for (const i of at)
    for (const words of REMOTE_WORDS) {
      const r = remoteAction([...argv.slice(0, i), ...words, ...argv.slice(i + 1)].filter((w) => w !== input));
      if (r !== undefined) return { ...r, label: `${r.label} (from xargs input)` };
    }
  return remoteAction(argv.filter((w) => w !== input));
}

/** The remote action one command, already unwrapped by `strippedArgvs`, is. */
export function remoteAction(argv: string[]): Remote | undefined {
  const name = program(argv[0]);
  const rest = argv.slice(1);
  const plain = name === "git" ? gitArgs(rest) : positional(rest);
  const [a = ""] = plain;
  const w = (...seq: string[]): boolean => plain.slice(0, 4).some((_, i) => seq.every((x, j) => plain[i + j] === x));
  const is = (kind: Remote["kind"], label = argv.join(" ")): Remote => ({ kind, label });
  const verbOf = (verbs: string[], tool: string): Remote | undefined => {
    const hit = verbs.find((v) => w(v));
    return hit === undefined ? undefined : is("deploy", `${tool} ${hit}`);
  };
  switch (name) {
    case "git":
      if (a === "push") return is("push", "git push");
      return a === "send-email" || a === "request-pull" ? is("upload", `git ${a}`) : undefined;
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return w("publish") ? is("publish", `${name} publish`) : undefined;
    case "cargo":
      return w("publish") ? is("publish", "cargo publish") : undefined;
    case "twine":
      return w("upload") ? is("publish", "twine upload") : undefined;
    case "gem":
      return w("push") ? is("publish", "gem push") : undefined;
    case "dotnet":
      return w("nuget", "push") ? is("publish", "dotnet nuget push") : undefined;
    case "mvn":
      return w("deploy") ? is("deploy", "mvn deploy") : undefined;
    case "docker":
    case "podman":
      return w("push") ? is("publish", `${name} push`) : undefined;
    case "gh": {
      for (const [g, hs] of GH_WRITES) {
        const h = hs.find((x) => w(g, x));
        if (h !== undefined) return is("upload", `gh ${g} ${h}`);
      }
      return plain.slice(0, 3).includes("api") && ghApiWrites(rest) ? is("upload", "gh api (non-GET)") : undefined;
    }
    case "vercel":
    case "netlify":
    case "fly":
      return w("deploy") ? is("deploy", `${name} deploy`) : undefined;
    case "wrangler":
      return w("deploy") || w("publish") ? is("deploy", `wrangler ${a}`) : undefined;
    case "terraform":
    case "tofu":
      return w("apply") || w("destroy") ? is("deploy", `${name} ${w("apply") ? "apply" : "destroy"}`) : undefined;
    case "pulumi":
      return w("up") || w("destroy") ? is("deploy", `pulumi ${w("up") ? "up" : "destroy"}`) : undefined;
    case "kubectl":
      return verbOf(["apply", "delete", "patch"], "kubectl");
    case "helm":
      return verbOf(["install", "upgrade", "uninstall"], "helm");
    case "curl":
      return curlUpload(rest) ? is("upload", "curl upload") : undefined;
    case "wget":
      return rest.some((x) => /^--post-/.test(x)) ? is("upload", "wget --post") : undefined;
    case "scp":
    case "rsync": {
      const last = positional(rest).at(-1);
      return last !== undefined && REMOTE_TARGET.test(last) ? is("upload", `${name} to a remote target`) : undefined;
    }
    default:
      return undefined;
  }
}

/** A force-push (`--force*`, `-f`, `+refspec`) of one of the `branches` by this unwrapped command, as its text; else undefined. */
export function forcePushToDefault(v: string[], branches: readonly string[]): string | undefined {
  if (program(v[0]) !== "git") return undefined;
  const args = gitArgs(v.slice(1));
  if (args[0] !== "push") return undefined;
  const rest = args.slice(1);
  const [, ...refs] = positional(rest);
  const forced = rest.some((a) => /^--(force|mirror|all)/.test(a) || /^-[a-zA-Z]*f/.test(a));
  const hits = (refs.length === 0 ? [""] : refs).some((r) => {
    const dst = (r.replace(/^\+/, "").split(":").at(-1) ?? "").replace(/^refs\/heads\//, "");
    // No named branch, or HEAD, may be the default branch: fail closed.
    return (forced || r.startsWith("+")) && (dst === "" || dst === "HEAD" || branches.includes(dst));
  });
  return hits ? v.join(" ") : undefined;
}

/** Words one xargs-input line can be that make a force-push reading: a force flag, the push itself, a default branch forced. A line is whole words (`push origin +main`), and a leading `.` stands for an option value so the push survives `gitArgs` (`xargs git -c`). Keep in step with `forcePushToDefault`'s spellings. */
const FORCE_INPUT = (branches: readonly string[]): string[][] => {
  const b = branches[0] ?? "main";
  return [
    ["--force"],
    ["push"],
    [`+${b}`],
    ["push", `+${b}`],
    ["push", "--force"],
    [".", "push", `+${b}`],
    [".", "push", "--force"],
  ];
};

/** The force-push (§5) this command could be once each `input` word is filled in at run time (xargs input), else the typed one. */
export function forcePushWithInput(argv: string[], input: string, branches: readonly string[]): string | undefined {
  const at = argv.flatMap((w, i) => (w === input ? [i] : []));
  if (at.length === 0) return forcePushToDefault(argv, branches);
  for (const i of at)
    for (const words of FORCE_INPUT(branches)) {
      const f = forcePushToDefault(
        [...argv.slice(0, i), ...words, ...argv.slice(i + 1)].filter((w) => w !== input),
        branches,
      );
      if (f !== undefined) return `${f} (from xargs input)`;
    }
  return forcePushToDefault(
    argv.filter((w) => w !== input),
    branches,
  );
}

const KILLERS = new Set(["kill", "taskkill", "stop-process", "pkill", "killall"]);

/** Process control aimed at Dovet: `deny` for its own pid or parent, `ask` for a pattern that could match it. */
export function selfControl(env: Env, argv: string[]): { behavior: "deny" | "ask"; reason: string } | undefined {
  const name = program(argv[0]);
  if (!KILLERS.has(name)) return undefined;
  const args = argv.slice(1);
  if (name === "pkill" || name === "killall" || (name === "stop-process" && args.some((a) => /^-name$/i.test(a)))) {
    const patterns = positional(args);
    const matches = patterns.some((p) => {
      try {
        return env.selfNames.some((n) => new RegExp(p, "i").test(n) || n.toLowerCase().includes(p.toLowerCase()));
      } catch {
        return true;
      }
    });
    return matches ? { behavior: "ask", reason: `${argv.join(" ")} could stop Dovet itself` } : undefined;
  }
  const own = [String(env.pid), String(env.ppid)];
  const hit = args.some((a) => own.includes(a));
  return hit ? { behavior: "deny", reason: "this would stop Dovet or its parent process" } : undefined;
}
