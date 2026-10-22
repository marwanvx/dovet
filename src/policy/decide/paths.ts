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
