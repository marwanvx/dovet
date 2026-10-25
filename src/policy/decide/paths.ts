// Path facts for the built-in checks: protected paths (permissions §4.3), sensitive files (§4.7) and the working-directory boundary (§4.1).
import ignore from "ignore";
import type { Os } from "../../platform/index.ts";
import { isWithin, lexicalPath, PathRefused } from "../../platform/index.ts";
import { toPosix } from "../rules/paths.ts";

export const PROTECTED_VERSION = 1;

export type Env = {
  os: Os;
  home: string;
  cwd: string;
  /** The primary working directory first, then the additional ones. */
  workingDirs: readonly string[];
  /** Real path of an absolute path; throws `PathRefused` for network and device paths. */
  canonicalize(abs: string): string;
  pid: number;
  ppid: number;
  /** Names `pkill`/`killall` patterns are tried against (the executable's name). */
  selfNames: readonly string[];
  /** The session's plan file, the one write plan mode allows. */
  planFile?: string | undefined;
  /** Directories under `.dovet`/`.claude` that hold Dovet's own plan and scratch files. */
  ownFiles?: readonly string[];
  /** `permissions.sensitiveFiles`. */
  sensitiveFiles?: readonly string[];
};

const PROTECTED_DIRS = [
  ".git",
  ".config/git",
  ".vscode",
  ".idea",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
  ".dovet",
  ".claude",
];
const PROTECTED_FILES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".bunfig.toml",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
  "gradle-wrapper.properties",
  "maven-wrapper.properties",
  ".devcontainer.json",
  ".ripgreprc",
  "pyrightconfig.json",
  ".mcp.json",
  ".claude.json",
]);

const segments = (abs: string, os: Os): string[] => toPosix(abs, os).split("/").filter(Boolean);

/** The protected directory or file `abs` is, or lies in; undefined when it is neither (or is one of Dovet's own files). */
export function protectedPath(abs: string, o: Pick<Env, "os" | "ownFiles">): string | undefined {
  if (o.ownFiles?.some((dir) => isWithin(abs, dir, o.os))) return undefined;
  const fold = o.os !== "linux";
  const segs = segments(abs, o.os).map((s) => (fold ? s.toLowerCase() : s));
  for (const dir of PROTECTED_DIRS) {
    const parts = dir.split("/");
    for (let i = 0; i + parts.length <= segs.length; i++) if (parts.every((p, j) => segs[i + j] === p)) return dir;
  }
  const last = segs.at(-1);
  return last !== undefined && PROTECTED_FILES.has(last) ? last : undefined;
}

const SENSITIVE = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/credentials.json",
  "**/*service-account*.json",
  "**/*.keystore",
  "**/.aws/credentials",
  "**/.docker/config.json",
  "**/secrets.y*ml",
  "**/*.tfvars",
  "**/terraform.tfstate*",
];
const HOME_CREDENTIALS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gcloud",
  ".azure",
  ".kube/config",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
];
const TEMPLATE = /\.(example|sample|template|dist)$/i;

/** Why `abs` is a sensitive file (the matching pattern), else undefined. */
export function sensitivePath(abs: string, o: Pick<Env, "os" | "home" | "sensitiveFiles">): string | undefined {
  const home = HOME_CREDENTIALS.find((c) => isWithin(abs, lexicalPath(c, o.home, o.os), o.os));
  if (home !== undefined) return `~/${home}`;
  const rel = toPosix(abs, o.os).replace(/^\/+/, "");
  if (rel === "") return undefined;
  const base = rel.split("/").at(-1) ?? "";
  if (/^\.env(\..+)?$/i.test(base) && TEMPLATE.test(base)) return undefined;
  return [...SENSITIVE, ...(o.sensitiveFiles ?? [])].find((p) =>
    ignore({ ignorecase: o.os !== "linux" })
      .add(p)
      .ignores(rel),
  );
}

const GLOB_CHAR = /[*?[]/;
const SENSITIVE_TAILS = SENSITIVE.map((p) => p.split("/").at(-1) ?? "").filter((t) => t !== "");

/** A single-segment fnmatch (find's -name grammar) as a matcher; a class it can't compile matches everything (fail closed). */
const fnmatch = (pattern: string, ic: boolean): ((s: string) => boolean) => {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < i + 2) re += "\\[";
      else {
        const body = pattern.slice(i + 1, end);
        re += `[${body.startsWith("!") || body.startsWith("^") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    const compiled = new RegExp(`^${re}$`, ic ? "i" : "");
    return (s) => compiled.test(s);
  } catch {
    return () => true;
  }
};

/** Whether a name matching the find test `value` could also match the name pattern `pattern` (both without a `/`). */
const nameOverlap = (value: string, pattern: string, ic: boolean): boolean => {
  if (value === "" || pattern === "") return false;
  if (!GLOB_CHAR.test(value)) return ignore({ ignorecase: ic }).add(pattern).ignores(value);
  if (!GLOB_CHAR.test(pattern)) return fnmatch(value, ic)(pattern);
  // Both hold wildcards. A name matching both must start with both literal prefixes and end with both literal
  // suffixes; a value starting with `*` against a pattern ending in one stays unchecked, so
  // `find . -name '*.pyc' -delete` still runs (permissions §4.4 Q93).
  const fold = (s: string): string => (ic ? s.toLowerCase() : s);
  const firstGlob = (s: string): number =>
    Math.min(...["*", "?", "["].map((c) => (s.indexOf(c) < 0 ? s.length : s.indexOf(c))));
  const lastGlob = (s: string): number => Math.max(...["*", "?", "["].map((c) => s.lastIndexOf(c)));
  const pv = fold(value.slice(0, firstGlob(value)));
  const sv = fold(value.slice(lastGlob(value) + 1));
  const pt = fold(pattern.slice(0, firstGlob(pattern)));
  const st = fold(pattern.slice(lastGlob(pattern) + 1));
  if (pv === "" && st === "") return false;
  if (sv !== "" && st !== "" && !sv.endsWith(st) && !st.endsWith(sv)) return false;
  if (pv !== "" && pt !== "" && !pv.startsWith(pt) && !pt.startsWith(pv)) return false;
  return true;
};

/** The sensitive-file pattern (§4.7) a file named by the find test `value` could be, wherever it lies (§4.4 Q93). */
export function sensitiveName(value: string, o: Pick<Env, "os" | "sensitiveFiles">, fold = false): string | undefined {
  if (!GLOB_CHAR.test(value) && /^\.env(\..+)?$/i.test(value) && TEMPLATE.test(value)) return undefined;
  const tails = [
    ...SENSITIVE_TAILS,
    ...(o.sensitiveFiles ?? []).map((p) => p.split("/").at(-1) ?? "").filter((t) => t !== ""),
  ];
  return tails.find((t) => nameOverlap(value, t, fold || o.os !== "linux"));
}

/** The protected path (§4.3) a file named by the find test `value` could be: a protected file's name or a protected directory. */
export function protectedName(value: string, o: Pick<Env, "os">, fold = false): string | undefined {
  const ic = fold || o.os !== "linux";
  for (const dir of PROTECTED_DIRS) if (nameOverlap(value, dir, ic)) return dir;
  for (const file of PROTECTED_FILES) if (nameOverlap(value, file, ic)) return file;
  return undefined;
}

/** The protected directory a find start path could be a parent of: its last segments are a proper prefix of one's, so
 * the reach could enter it (`find .config -name config -delete` reaches `.config/git/config`, §4.3). */
export function protectedDirAbove(start: string, o: Pick<Env, "os">): string | undefined {
  const fold = (s: string): string => (o.os !== "linux" ? s.toLowerCase() : s);
  const segs = start.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  for (const dir of PROTECTED_DIRS) {
    const parts = dir.split("/");
    for (let k = Math.min(segs.length, parts.length - 1); k >= 1; k--) {
      const tail = segs
        .slice(segs.length - k)
        .map(fold)
        .join("/");
      if (tail === fold(parts.slice(0, k).join("/"))) return dir;
    }
  }
  return undefined;
}

export type Forms = { requested: string; canonical: string };

/** The requested and the real spelling of a path, or undefined when it is refused (UNC, device). */
export function resolveForms(env: Env, path: string, cwd: string): Forms | undefined {
  try {
    const requested = lexicalPath(path, cwd, env.os);
    return { requested, canonical: env.canonicalize(requested) };
  } catch (e) {
    if (e instanceof PathRefused) return undefined;
    throw e;
  }
}

/** Is the path inside the working directories in both spellings? */
export function insideWorkingDirs(env: Env, f: Forms): boolean {
  const dirs = env.workingDirs.flatMap((d) => {
    try {
      return [d, env.canonicalize(d)];
    } catch (e) {
      if (e instanceof PathRefused) return [d];
      throw e;
    }
  });
  return [f.requested, f.canonical].every((p) => dirs.some((d) => isWithin(p, d, env.os)));
}
