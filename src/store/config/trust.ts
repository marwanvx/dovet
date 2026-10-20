import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isErrno, type Os, pathKey, runHardenedGit } from "../../platform/index.ts";
import type { AbsPath, Settings } from "../../schema/index.ts";
import { SettingsError } from "./errors.ts";
import { readSettingsText } from "./read.ts";
import { writeFileAtomic } from "./write.ts";

/** Which repo-supplied settings files may grant capability (permissions §11). */
export type ProjectTrust = { project: boolean; local: boolean };
export const UNTRUSTED: ProjectTrust = { project: false, local: false };

export type UntrustedSettings = { file: string; allowRules: number; ignored: string[] };

export type TrustedFolders = Record<string, { hash: string; trusted: boolean }>;

const SAFE_TOP_LEVEL = [
  "$schema",
  "$version",
  "provider",
  "model",
  "effort",
  "ui",
  "compaction",
  "cache",
  "instructions",
  "read",
  "glob",
  "webfetch",
  "compat",
  "git",
] as const;
const CAUTIOUS_MODES: readonly string[] = ["default", "plan", "dontAsk"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function present(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

function ignoredPaths(original: unknown, kept: unknown, path: string, out: string[]): void {
  if (isObject(original)) {
    for (const [key, value] of Object.entries(original)) {
      const child = path === "" ? key : `${path}.${key}`;
      ignoredPaths(value, isObject(kept) ? kept[key] : undefined, child, out);
    }
    return;
  }
  if (JSON.stringify(original) !== JSON.stringify(kept)) out.push(path);
}

/**
 * What a repo-supplied settings file may still say before the folder is trusted (cli-config "Security exception"):
 * rules that only restrict, and settings that grant nothing. An allowlist, so a key added later is ignored until it's classified.
 */
export function restrictUntrusted(settings: Settings): { kept: Settings; ignored: string[]; allowRules: number } {
  const kept: Record<string, unknown> = {};
  for (const key of SAFE_TOP_LEVEL) {
    if (settings[key] !== undefined) kept[key] = settings[key];
  }
  const p = settings.permissions;
  if (p !== undefined) {
    const permissions = present({
      deny: p.deny,
      ask: p.ask,
      examples: p.examples,
      disableBypassPermissionsMode: p.disableBypassPermissionsMode,
      blockReadsOutsideWorkingDirectories: p.blockReadsOutsideWorkingDirectories === true ? true : undefined,
      defaultMode: p.defaultMode !== undefined && CAUTIOUS_MODES.includes(p.defaultMode) ? p.defaultMode : undefined,
      sensitiveFiles: p.sensitiveFiles?.add === undefined ? undefined : { add: p.sensitiveFiles.add },
    });
    if (Object.keys(permissions).length > 0) kept.permissions = permissions;
  }
  const s = settings.sandbox;
  if (s !== undefined) {
    const network = present({
      deniedDomains: s.network?.deniedDomains,
      strictAllowlist: s.network?.strictAllowlist === true ? true : undefined,
    });
    const filesystem = present({ denyWrite: s.filesystem?.denyWrite, denyRead: s.filesystem?.denyRead });
    const sandbox = present({
      enabled: s.enabled === true ? true : undefined,
      failIfUnavailable: s.failIfUnavailable === true ? true : undefined,
      allowUnsandboxedCommands: s.allowUnsandboxedCommands === false ? false : undefined,
      autoAllowBashIfSandboxed: s.autoAllowBashIfSandboxed === false ? false : undefined,
      credentials: s.credentials,
      network: Object.keys(network).length > 0 ? network : undefined,
      filesystem: Object.keys(filesystem).length > 0 ? filesystem : undefined,
    });
    if (Object.keys(sandbox).length > 0) kept.sandbox = sandbox;
  }
  const ignored: string[] = [];
  ignoredPaths(settings, kept, "", ignored);
  return { kept: kept as Settings, ignored: ignored.sort(), allowRules: p?.allow?.length ?? 0 };
}

const missing = (err: unknown): undefined => {
  if (isErrno(err, "ENOENT", "ENOTDIR")) return undefined;
  throw err;
};

/** permissions §11: the local files are personal unless git tracks one or `.dovet` / `.claude` is a symlink (a repo can ship either). */
export async function localSettingsRepoSupplied(input: {
  projectRoot: string;
  git?: AbsPath;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<boolean> {
  for (const dir of [".dovet", ".claude"]) {
    if ((await lstat(join(input.projectRoot, dir)).catch(missing))?.isSymbolicLink()) return true;
  }
  if ((await lstat(join(input.projectRoot, ".git")).catch(missing)) === undefined) return false;
  // A repository whose git can't answer is treated as repo-supplied: trust is never granted by a failure.
  if (input.git === undefined) return true;
  const call = { git: input.git, cwd: input.projectRoot as AbsPath, env: input.env };
  for (const dir of [".dovet", ".claude"]) {
    const tracked = await runHardenedGit(call, ["ls-files", "--error-unmatch", "--", `${dir}/settings.local.json`]);
    if (tracked.code !== 1) return true;
  }
  return false;
}

/** The text a trust decision covers: the repo-supplied settings files, so any edit asks again (cli-config "Security exception"). */
export async function projectConfigHash(input: { projectRoot: string; includeLocal: boolean }): Promise<string> {
  const names = [".dovet/settings.json", ".claude/settings.json"];
  if (input.includeLocal) names.push(".dovet/settings.local.json", ".claude/settings.local.json");
  const hash = createHash("sha256");
  for (const name of names) {
    const text = await readSettingsText(join(input.projectRoot, ...name.split("/"))).catch((err: unknown) => {
      if (err instanceof SettingsError) return `unreadable: ${err.message}`;
      throw err;
    });
    if (text !== undefined) hash.update(`${name}\0${text}\0`);
  }
  return hash.digest("hex");
}

const isHome = (root: string, home: string, os: Os): boolean => pathKey(root, os) === pathKey(home, os);

/** The recorded decision for this repo root, valid only for the config it was made on; the home directory is never trusted. */
export function folderTrusted(store: TrustedFolders, root: string, hash: string, home: string, os: Os): boolean {
  if (isHome(root, home, os)) return false;
  const entry = store[root];
  return entry !== undefined && entry.trusted && entry.hash === hash;
}

export async function recordTrust(input: {
  dataDir: string;
  store: TrustedFolders;
  root: string;
  hash: string;
  trusted: boolean;
  home: string;
  os: Os;
}): Promise<void> {
  if (isHome(input.root, input.home, input.os)) throw new Error("the home directory is never recorded as trusted");
  await mkdir(input.dataDir, { recursive: true, mode: 0o700 });
  const next = { ...input.store, [input.root]: { hash: input.hash, trusted: input.trusted } };
  await writeFileAtomic(join(input.dataDir, "trusted-folders.json"), `${JSON.stringify(next, null, 2)}\n`);
}

/** What a session may take from the repo's own settings: the dialog's decision for the project files, and the local file's own rule. */
export async function resolveProjectTrust(input: {
  projectRoot: string;
  store: TrustedFolders;
  home: string;
  os: Os;
  git?: AbsPath;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<ProjectTrust> {
  const localSupplied = await localSettingsRepoSupplied(input);
  const hash = await projectConfigHash({ projectRoot: input.projectRoot, includeLocal: localSupplied });
  const project = folderTrusted(input.store, input.projectRoot, hash, input.home, input.os);
  return { project, local: project || !localSupplied };
}
