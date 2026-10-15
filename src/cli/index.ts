// Public surface of the `cli` module (docs/specs/architecture.md "Modules"): Entry point, argument parsing, headless output formats, doctor.
// Other modules import only from this file.
export { type HeadlessArgs, type OutputFormat, type ParseResult, parseHeadlessArgs } from "./args.ts";
export {
  combineStdinAndPrompt,
  exitCodeFor,
  formatJson,
  formatStreamJson,
  HeadlessJson,
  type HeadlessOutcome,
  STDIN_MAX_BYTES,
  StreamJson,
} from "./headless-output.ts";
export {
  ensureDataDir,
  filterInheritedEnv,
  loadTrustedFolders,
  offlineRefusal,
} from "./startup.ts";
