// Remote actions (permissions §4.8) and self-protection (§4.4b), recognized from the analyzer's argv.
import { strippedArgvs } from "../rules/index.ts";
import type { Env } from "./paths.ts";

export const REMOTE_VERSION = 1;

export type RemoteKind = "push" | "publish" | "upload" | "deploy";
type Remote = { kind: RemoteKind; label: string };

const GIT_OPTION_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** `git -C dir -c k=v push …` → `["push", …]`. */
function gitArgs(args: string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (GIT_OPTION_VALUES.has(a)) i++;
    else if (!a.startsWith("-")) return args.slice(i);
  }
  return [];
}

const positional = (args: string[]): string[] => args.filter((a) => !a.startsWith("-"));
const curlUpload = (args: string[]): boolean =>
  args.some(
    (a, i) =>
      /^--(data|form|json|upload-file)/.test(a) ||
      /^-[A-Za-z]*[dFT]/.test(a) ||
      /^-X\s*(POST|PUT|PATCH|DELETE)$/i.test(a) ||
      /^--request=(POST|PUT|PATCH|DELETE)$/i.test(a) ||
      ((a === "-X" || a === "--request") && /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? "")),
  );
const ghApiWrites = (args: string[]): boolean =>
  args.some(
    (a, i) =>
      /^(-f|-F|--field|--raw-field|--input)$/.test(a) ||
      ((a === "-X" || a === "--method") && !/^GET$/i.test(args[i + 1] ?? "")) ||
      (/^--method=/.test(a) && !/^GET$/i.test(a.slice(9))),
  );
const REMOTE_TARGET = /^(?:[\w.-]+@)?[\w.-]{2,}:|^rsync:\/\//;

function oneRemote(argv: string[]): Remote | undefined {
  const [name = "", ...rest] = argv;
  const [a = "", b = ""] = name === "git" ? gitArgs(rest) : rest;
  const is = (kind: Remote["kind"], label = argv.join(" ")): Remote => ({ kind, label });
  switch (name) {
    case "git":
      if (a === "push") return is("push", "git push");
      return a === "send-email" || a === "request-pull" ? is("upload", `git ${a}`) : undefined;
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return a === "publish" ? is("publish", `${name} publish`) : undefined;
    case "cargo":
      return a === "publish" ? is("publish", "cargo publish") : undefined;
    case "twine":
      return a === "upload" ? is("publish", "twine upload") : undefined;
    case "gem":
      return a === "push" ? is("publish", "gem push") : undefined;
    case "dotnet":
      return a === "nuget" && b === "push" ? is("publish", "dotnet nuget push") : undefined;
    case "mvn":
      return a === "deploy" ? is("deploy", "mvn deploy") : undefined;
    case "docker":
    case "podman":
      return a === "push" ? is("publish", `${name} push`) : undefined;
    case "gh": {
      const [g, h] = positional(rest);
      const hit =
        (g === "pr" && ["create", "merge", "comment", "review"].includes(h ?? "")) ||
        (g === "issue" && ["create", "comment"].includes(h ?? "")) ||
        (g === "release" && h === "create") ||
        (g === "repo" && ["create", "delete"].includes(h ?? "")) ||
        (g === "gist" && h === "create") ||
        (g === "api" && ghApiWrites(rest)) ||
        (g === "workflow" && h === "run");
      return hit ? is("upload", `gh ${g} ${g === "api" ? "(non-GET)" : h}`) : undefined;
    }
    case "vercel":
    case "netlify":
    case "fly":
      return a === "deploy" ? is("deploy", `${name} deploy`) : undefined;
    case "wrangler":
      return a === "deploy" || a === "publish" ? is("deploy", `wrangler ${a}`) : undefined;
    case "terraform":
    case "tofu":
      return a === "apply" || a === "destroy" ? is("deploy", `${name} ${a}`) : undefined;
    case "pulumi":
      return a === "up" || a === "destroy" ? is("deploy", `pulumi ${a}`) : undefined;
    case "kubectl":
      return ["apply", "delete", "patch"].includes(a) ? is("deploy", `kubectl ${a}`) : undefined;
    case "helm":
      return ["install", "upgrade", "uninstall"].includes(a) ? is("deploy", `helm ${a}`) : undefined;
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

/** The remote action a command is, looking through wrappers (`sudo git push`). */
export function remoteAction(argv: string[]): Remote | undefined {
  for (const v of strippedArgvs(argv)) {
    const hit = oneRemote(v);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** A force-push (`--force*`, `-f`, `+refspec`) of one of the `branches`, as the full command text; else undefined. */
export function forcePushToDefault(argv: string[], branches: readonly string[]): string | undefined {
  for (const v of strippedArgvs(argv)) {
    if (v[0] !== "git") continue;
    const args = gitArgs(v.slice(1));
    if (args[0] !== "push") continue;
    const rest = args.slice(1);
    const [, ...refs] = positional(rest);
    const forced = rest.some((a) => /^--force/.test(a) || /^-[a-zA-Z]*f/.test(a));
    const hits = refs.some((r) => {
      const plus = r.startsWith("+");
      const dst = (r.replace(/^\+/, "").split(":").at(-1) ?? "").replace(/^refs\/heads\//, "");
      return (forced || plus) && branches.includes(dst);
    });
    if (hits) return v.join(" ");
  }
  return undefined;
}

const KILLERS = new Set(["kill", "taskkill", "stop-process", "pkill", "killall"]);

/** Process control aimed at Dovet: `deny` for its own pid or parent, `ask` for a pattern that could match it. */
export function selfControl(env: Env, argv: string[]): { behavior: "deny" | "ask"; reason: string } | undefined {
  const name = argv[0]?.toLowerCase() ?? "";
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
