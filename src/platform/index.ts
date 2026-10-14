// Public surface of the `platform` module (docs/specs/architecture.md "Modules"): OS abstraction: directories, shells, processes, paths, terminal detection.
// Other modules import only from this file.
export { createPlatformCore, type PlatformCore } from "./core.ts";
export { type Dirs, resolveDirs } from "./dirs.ts";
export { isErrno } from "./errno.ts";
export { createExecResolver, type ExecResolver } from "./exec.ts";
export { GIT_HARDENING_ARGS, type GitCall, type GitHead, hardenedGitEnv, readGitHead, runHardenedGit } from "./git.ts";
export { type LibexecName, libexecPath } from "./libexec.ts";
export { describeOs } from "./os-label.ts";
export { canonicalizePath, isWithin, lexicalPath, PathRefused, pathKey } from "./paths.ts";
export { resolveShell, type ShellDeps } from "./shell.ts";
export type { ChildHandle, Os, Platform, ShellChoice, ShellSetting } from "./types.ts";
