// Public surface of the `platform` module (docs/specs/architecture.md "Modules"): OS abstraction: directories, shells, processes, paths, terminal detection.
// Other modules import only from this file.
export { type LibexecName, libexecPath } from "./libexec.ts";
export type { ChildHandle, Platform } from "./types.ts";
