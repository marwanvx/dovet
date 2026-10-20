import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isErrno, type Os, pathKey, runHardenedGit } from "../../platform/index.ts";
import type { AbsPath, Settings } from "../../schema/index.ts";
import { writeFileAtomic } from "./atomic.ts";
import { SettingsError } from "./errors.ts";
import { localFileRecorded } from "./local-record.ts";
import { readSettingsText } from "./read.ts";

/** Which repo-supplied settings files may grant capability (permissions §11). */
export type ProjectTrust = { project: boolean; local: boolean };
export const UNTRUSTED: ProjectTrust = { project: false, local: false };

export type UntrustedSettings = { file: string; allowRules: number; ignored: string[] };

export type TrustedFolders = Record<string, { hash: string; trusted: boolean }>;

// Only settings that no value in a repo file can turn into less than the user chose: merge lets the higher layer
// replace scalars and non-rule arrays, so a list or a mode from an untrusted file would wipe the user's own.
const SAFE_TOP_LEVEL = ["$schema", "$version", "ui"] as const;

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
      disableBypassPermissionsMode: p.disableBypassPermissionsMode,
      blockReadsOutsideWorkingDirectories: p.blockReadsOutsideWorkingDirectories === true ? true : undefined,
    });
    if (Object.keys(permissions).length > 0) kept.permissions = permissions;
  }
  const s = settings.sandbox;
  if (s !== undefined) {
    const sandbox = present({
      enabled: s.enabled === true ? true : undefined,
      failIfUnavailable: s.failIfUnavailable === true ? true : undefined,
      allowUnsandboxedCommands: s.allowUnsandboxedCommands === false ? false : undefined,
      autoAllowBashIfSandboxed: s.autoAllowBashIfSandboxed === false ? false : undefined,
      network: s.network?.strictAllowlist === true ? { strictAllowlist: true } : undefined,
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

// `ls-files -s` prints `<mode> <object> <stage>\t<path>`; mode 160000 is a submodule, whose files git doesn't list.
const GITLINK = /^160000 /;

/**
 * permissions §11: the local files are personal unless the repo can ship them: `.dovet` / `.claude` is a symlink or a
 * submodule, git tracks a `settings.local.json`, or there is no git to tell (an unpacked archive).
 * A repository whose git can't answer counts as repo-supplied too: trust is never granted by a failure.
 */
export async function localSettingsRepoSupplied(input: {
  projectRoot: string;
  git?: AbsPath;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<boolean> {
  for (const dir of [".dovet", ".claude"]) {
    const info = await lstat(join(input.projectRoot, dir)).catch(missing);
    if (info?.isSymbolicLink()) return true;
    if (info !== undefined && (await lstat(join(input.projectRoot, dir, ".git")).catch(missing)) !== undefined) {
      return true;
    }
  }
  if ((await lstat(join(input.projectRoot, ".git")).catch(missing)) === undefined) return true;
  if (input.git === undefined) return true;
  const call = { git: input.git, cwd: input.projectRoot as AbsPath, env: input.env };
  for (const dir of [".dovet", ".claude"]) {
    // icase: on a case-insensitive volume `.Dovet/Settings.Local.json` opens as the file Dovet reads.
    const listed = await runHardenedGit(call, ["ls-files", "-s", "--", `:(icase)${dir}`]);
    if (listed.code !== 0) return true;
    const local = `${dir}/settings.local.json`;
    for (const line of listed.stdout.split("\n")) {
      const path = line.slice(line.indexOf("\t") + 1).toLowerCase();
      if (GITLINK.test(line) || path === local) return true;
    }
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
  const entry = store[pathKey(root, os)];
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
  const next = { ...input.store, [pathKey(input.root, input.os)]: { hash: input.hash, trusted: input.trusted } };
  await writeFileAtomic(join(input.dataDir, "trusted-folders.json"), `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * permissions §11: a local file is personal only when it is exactly what Dovet last wrote for this project (a hash in
 * `<data>`). `.claude/settings.local.json` is never written by Dovet, so it never is. No local file: nothing to distrust.
 */
async function localFileIsPersonal(input: { projectRoot: string; dataDir: string; os: Os }): Promise<boolean> {
  const read = (name: string) =>
    readSettingsText(join(input.projectRoot, ...name.split("/"))).catch((err: unknown) => {
      if (err instanceof SettingsError) return null;
      throw err;
    });
  const [dovet, claude] = await Promise.all([read(".dovet/settings.local.json"), read(".claude/settings.local.json")]);
  if (dovet === null || claude === null || claude !== undefined) return false;
  return dovet === undefined || (await localFileRecorded(input, input.projectRoot, dovet));
}

/** What a session may take from the repo's own settings: the dialog's decision for the project files, and the local file's own rule. */
export async function resolveProjectTrust(input: {
  projectRoot: string;
  store: TrustedFolders;
  home: string;
  os: Os;
  dataDir: string;
  git?: AbsPath;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<ProjectTrust> {
  const localSupplied = (await localSettingsRepoSupplied(input)) || !(await localFileIsPersonal(input));
  const hash = await projectConfigHash({ projectRoot: input.projectRoot, includeLocal: localSupplied });
  const project = folderTrusted(input.store, input.projectRoot, hash, input.home, input.os);
  return { project, local: project || !localSupplied };
}
