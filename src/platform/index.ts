// Public surface of the `platform` module (docs/specs/architecture.md "Modules"): OS abstraction: directories, shells, processes, paths, terminal detection.
// Other modules import only from this file.
export { createPlatformCore, type PlatformCore } from "./core.ts";
export { type Dirs, resolveDirs } from "./dirs.ts";
export { isErrno } from "./errno.ts";
export { createExecResolver, type ExecResolver } from "./exec.ts";
export { type LibexecName, libexecPath } from "./libexec.ts";
export { canonicalizePath, isWithin, PathRefused, pathKey } from "./paths.ts";
export type { ChildHandle, Os, Platform } from "./types.ts";
