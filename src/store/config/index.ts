export { describeProblem, type Problem, SettingsError } from "./errors.ts";
export { type ExternalImportApprovals, externalImportApprovals } from "./external-imports.ts";
export { type LoadedSettings, type LoadInput, loadSettings } from "./load.ts";
export type { RuleKind, SettingsSource, SourcedRule } from "./merge.ts";
export { type Change, MIGRATIONS, type Migration, type PendingMigration } from "./migrate.ts";
export { findProjectRoot } from "./project-root.ts";
export {
  pollSettings,
  type ReloadResult,
  type SettingsChangeEvent,
  type SettingsSnapshot,
  snapshotSettings,
  watchedSettingsPaths,
} from "./reload.ts";
export {
  folderTrusted,
  localSettingsRepoSupplied,
  type ProjectTrust,
  projectConfigHash,
  recordTrust,
  resolveProjectTrust,
  type TrustedFolders,
  UNTRUSTED,
  type UntrustedSettings,
} from "./trust.ts";
export { saveLocalRule, writeFileAtomic } from "./write.ts";
