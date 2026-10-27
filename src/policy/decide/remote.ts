// Remote actions (permissions §4.8) and self-protection (§4.4b), recognized from the analyzer's argv.
import { commandName, gitInvocation, gitOptionValues, isLongOption } from "../rules/index.ts";
import type { Env } from "./paths.ts";
import { unresolvedTarget } from "./targets.ts";

export const REMOTE_VERSION = 1;

export type RemoteKind = "push" | "publish" | "upload" | "deploy";
type Remote = { kind: RemoteKind; label: string };

/** git's built-in commands (2.53): git runs one of them in place of an alias of its name. Script commands a distro may
 * ship separately (`subtree`, `instaweb`, `gui`), the deprecated ones an alias may replace and the ones that send to a
 * remote are left out. */
const GIT_COMMANDS = new Set(
  `add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore
  check-mailmap check-ref-format checkout checkout--worker checkout-index cherry cherry-pick clean clone column
  commit commit-graph commit-tree config count-objects credential credential-cache credential-cache--daemon
  credential-store daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool
  fast-export fast-import fetch fetch-pack fmt-merge-msg for-each-ref for-each-repo format-patch fsck
  fsck-objects fsmonitor--daemon gc get-tar-commit-id grep hash-object help hook http-backend http-fetch
  index-pack init init-db interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit
  maintenance merge merge-base merge-file merge-index merge-ours merge-recursive
  merge-recursive-ours merge-recursive-theirs merge-subtree merge-tree mktag mktree
  multi-pack-index mv name-rev notes pack-objects pack-refs patch-id pickaxe prune prune-packed pull
  range-diff read-tree rebase receive-pack reflog refs remote repack replace replay repo rerere reset restore rev-list
  rev-parse revert rm sh-i18n--envsubst shell shortlog show show-branch show-index show-ref sparse-checkout stage
  stash status stripspace submodule submodule--helper switch symbolic-ref tag unpack-file unpack-objects
  update-index update-ref update-server-info upload-archive upload-archive--writer upload-pack var verify-commit
  verify-pack verify-tag version worktree write-tree`.split(/\s+/),
);
const GIT_PUSHES = new Set(["push", "send-pack", "http-push"]);
const GIT_UPLOADS = new Set(["send-email", "request-pull", "imap-send"]);
/** Inline configuration that only changes what git shows or records; any other key may name a program git runs. */
const QUIET_GIT_CONFIG =
  /^(?:(?:user|advice|i18n|column|status)\.[\w-]+|color\.[\w.-]+|core\.(?:quotepath|autocrlf|safecrlf|filemode|ignorecase|abbrev|longpaths)|init\.defaultbranch|safe\.directory|(?:commit|tag)\.gpgsign|pull\.(?:rebase|ff)|merge\.ff|log\.(?:decorate|date))$/i;

/** `git -C dir -c k=v push …` → `["push", …]`. */
const gitArgs = (args: string[]): string[] => args.slice(gitInvocation(args).at);

/** A git command that could reach a remote without naming it: configuration that runs a program, an alias from
 * `--config-env` or a config file, an add-on (`git lfs`), a remote helper or a `!` alias. */
function gitHidden(rest: string[], a: string): Remote | undefined {
  const { config } = gitInvocation(rest);
  const opaque = config.find(
    ([k, v]) => v === undefined || !(k.toLowerCase().startsWith("alias.") || QUIET_GIT_CONFIG.test(k)),
  );
  if (opaque !== undefined)
    return {
      kind: "push",
      label: `git ${opaque[1] === undefined ? "--config-env" : "-c"} ${opaque[0]} (configuration that can run a command)`,
    };
  if (a === "" || GIT_COMMANDS.has(a)) return undefined;
  // An inline alias is read through its expansion (`gitAlias`); only a `!` one stays opaque on PowerShell.
  const alias = config.findLast(([k]) => k.toLowerCase() === `alias.${a.toLowerCase()}`)?.[1];
  if (alias !== undefined && !alias.startsWith("!")) return undefined;
  return { kind: "push", label: `git ${a} (not a git command: an alias or add-on could push)` };
}

/** Environment variables git (or its pager) reads configuration or a program to run from. */
const GIT_ENV_NAMES =
  "GIT_CONFIG\\w*|GIT_SSH(?:_COMMAND)?|GIT_PAGER|GIT_(?:SEQUENCE_)?EDITOR|GIT_EXTERNAL_DIFF|GIT_ASKPASS|GIT_PROXY_COMMAND|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_ALLOW_PROTOCOL|PAGER|EDITOR|VISUAL|SSH_ASKPASS|LESSOPEN|LESSCLOSE";
const GIT_ENV = new RegExp(`^(${GIT_ENV_NAMES})=(.*)$`, "s");
const GIT_ENV_NAME = new RegExp(`^(?:env:)?(${GIT_ENV_NAMES})$`, "i");
const ENV_SETTERS = new Set(["env", "export", "declare", "typeset", "local", "readonly", "sudo", "doas"]);
/** Commands that set a variable a word names (`printf -v NAME`, `read NAME`, `export NAME`, `Set-Item env:NAME`). */
const NAME_SETTERS = new Set([
  ...["export", "declare", "typeset", "local", "readonly", "printf", "read", "mapfile", "readarray"],
  ...[
    "set-item",
    "si",
    "new-item",
    "ni",
    "set-content",
    "sc",
    "add-content",
    "ac",
    "copy-item",
    "move-item",
    "rename-item",
  ],
]);

/** The git environment variable a command sets (`GIT_CONFIG_COUNT=1 git log`, `export GIT_SSH_COMMAND=…`), if any; a
 * pager or editor whose value is one program and its options is quiet unless that program runs others. */
function gitEnvironment(argv: string[]): string | undefined {
  const name = commandName(argv[0]);
  if (NAME_SETTERS.has(name)) {
    const hit = argv.slice(1).find((w) => GIT_ENV_NAME.test(w));
    if (hit !== undefined) return hit.replace(/^env:/i, "");
  }
  if (!(ENV_SETTERS.has(name) || /^\w+=/.test(argv[0] ?? ""))) return undefined;
  for (const w of argv) {
    const m = GIT_ENV.exec(w);
    if (m === null) continue;
    // A pager's display options only; less's `-k`/`--lesskey*` and any editor option can load commands from a file.
    const quiet =
      /PAGER|EDITOR|VISUAL/.test(m[1] ?? "") &&
      /^(?:(?:cat|less|more)(?:\s+-(?!\w*k)(?!-lesskey)[\w=-]*)*|true|:|vim?|nano)?$/.test(m[2] ?? "");
    if (!quiet) return m[1];
  }
  return undefined;
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

/** git-push's long options that make a push force-like (`--branches` is git's alias of `--all`); git reads a unique prefix as the option, so the abbreviations deny too. */
const FORCE_LONGS = ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--all", "--branches"];
const WGET_POST_LONGS = ["--post-data", "--post-file", "--body-data", "--body-file"];

const GH_WRITES: Array<[string, string[]]> = [
  ["pr", ["create", "merge", "comment", "review"]],
  ["issue", ["create", "comment"]],
  ["release", ["create", "upload"]],
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
  const env = gitEnvironment(argv);
  if (env !== undefined) return is("push", `${env} (git configuration or a program git runs, from the environment)`);
  switch (name) {
    case "git":
      if (GIT_PUSHES.has(a)) return is("push", `git ${a}`);
      if (GIT_UPLOADS.has(a)) return is("upload", `git ${a}`);
      if (a === "subtree" && w("push")) return is("push", "git subtree push");
      // clone sets its `-c`/`--config` configuration before it fetches.
      if (a === "clone") {
        const key = gitOptionValues(gitArgs(rest).slice(1), "c", "--config")
          .map((kv) => kv.split("=", 1)[0] ?? "")
          .find((k) => !QUIET_GIT_CONFIG.test(k));
        if (key !== undefined) return is("push", `git clone -c ${key} (configuration that can run a command)`);
      }
      return gitHidden(rest, a);
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
    case "wget": {
      const methods = rest.flatMap((x, i) =>
        isLongOption("--method", x) ? [x.includes("=") ? x.slice(x.indexOf("=") + 1) : (rest[i + 1] ?? "")] : [],
      );
      // wgetrc commands (`-e method=POST`, bundled `-qe`) match with case, `-` and `_` ignored, as wget reads them.
      const wgetrc = rest.flatMap((x, i) => {
        if (isLongOption("--execute", x)) return [x.includes("=") ? x.slice(x.indexOf("=") + 1) : (rest[i + 1] ?? "")];
        const m = /^-[^-e]*e(.*)$/s.exec(x);
        return m === null ? [] : [m[1] || (rest[i + 1] ?? "")];
      });
      // A wgetrc file (`--config`) may set the method or the body.
      return rest.some((x) => [...WGET_POST_LONGS, "--config"].some((n) => isLongOption(n, x))) ||
        wgetrc.some((c) =>
          /^(method|postdata|postfile|bodydata|bodyfile)=/.test(c.replace(/[\s_-]/g, "").toLowerCase()),
        ) ||
        methods.some((m) => !/^(GET|HEAD|OPTIONS)$/i.test(m))
        ? is("upload", "wget --post")
        : undefined;
    }
    case "npx":
    case "bunx":
    case "pnpx":
      // The runner runs the command its first operand names; every start is tried, and a `-c` script loses its quotes and is split at shell separators.
      for (const [i, x] of rest.entries()) {
        const call = /^(-c|--call)$/.test(rest[i - 1] ?? "") ? x : /^--call=/.test(x) ? x.slice(7) : undefined;
        const r = remoteAction(
          call === undefined
            ? rest.slice(i)
            : [
                name,
                ...call
                  .replace(/["'\\]/g, "")
                  .split(/[\s;&|()<>`$]+/)
                  .filter((w) => w !== ""),
              ],
        );
        if (r !== undefined) return r;
      }
      return undefined;
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
  const pos = positional(rest);
  // A leading `+` reads as the refspec of a remoteless push; misreading a real remote this way only adds denies.
  const refs = pos[0]?.startsWith("+") ? pos : pos.slice(1);
  const forced = rest.some((a) => /^-[a-zA-Z]*f/.test(a) || FORCE_LONGS.some((n) => isLongOption(n, a)));
  const hits = (refs.length === 0 ? [""] : refs).some((r) => {
    const dst = (r.replace(/^\+/, "").split(":").at(-1) ?? "").replace(/^refs\/heads\//, "");
    // No named branch, HEAD, or one known only at run time, may be the default branch: fail closed.
    return (
      (forced || r.startsWith("+")) && (dst === "" || dst === "HEAD" || unresolvedTarget(dst) || branches.includes(dst))
    );
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
