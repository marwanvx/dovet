// Live settings reload (cli-config "Live settings reload"): stat polling before each turn and tool batch.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { isErrno } from "../../platform/index.ts";
import type { Settings } from "../../schema/index.ts";
import type { Problem } from "./errors.ts";
import { type LoadedSettings, type LoadInput, loadSettings } from "./load.ts";

export type FileSig = {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
  ino?: string;
  isFile?: boolean;
};
export type DirSig = { exists: boolean; mtimeMs?: number };

export type SettingsSnapshot = {
  files: Record<string, FileSig>;
  dirs: Record<string, DirSig>;
  loaded: LoadedSettings;
};

export type SettingsChangeEvent = {
  key: string;
  old: unknown;
  new: unknown;
  source: "file";
};

export type ReloadResult = {
  changed: boolean;
  snapshot: SettingsSnapshot;
  loaded: LoadedSettings;
  settings: Settings;
  notices: string[];
  warnings: Problem[];
  events: SettingsChangeEvent[];
  announced: string[];
};

// ASSUMPTION (QUESTIONS Q45): only model/provider/effort are held back. Tool definitions
// still block mid-epoch per permissions §3.1; the epoch update is M1-25. Thinking has no
// settings key in v0.1.
const MODEL_KEYS = ["model", "provider", "effort"] as const;

export function watchedSettingsPaths(input: Pick<LoadInput, "dirs" | "home" | "projectRoot">): {
  files: string[];
  dirs: string[];
} {
  const dovet = join(input.projectRoot, ".dovet");
  const claude = join(input.projectRoot, ".claude");
  const files = [join(input.dirs.config, "settings.json"), join(dovet, "settings.local.json")];
  const dirs = [input.dirs.config, dovet];
  files.push(join(input.home, ".claude", "settings.json"));
  dirs.push(join(input.home, ".claude"));
  files.push(join(dovet, "settings.json"), join(claude, "settings.json"), join(claude, "settings.local.json"));
  dirs.push(claude);
  return { files, dirs };
}

async function sigOfFile(path: string): Promise<FileSig> {
  try {
    // bigint: a 64-bit Windows file ID loses its low bits as a double, so a replaced file could look unchanged.
    const s = await stat(path, { bigint: true });
    return {
      exists: true,
      mtimeMs: Number(s.mtimeNs) / 1e6,
      size: Number(s.size),
      ino: String(s.ino),
      isFile: s.isFile(),
    };
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return { exists: false };
    return { exists: true, mtimeMs: -1, size: -1, isFile: false };
  }
}

async function sigOfDir(path: string): Promise<DirSig> {
  try {
    const s = await stat(path);
    return { exists: true, mtimeMs: s.mtimeMs };
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return { exists: false };
    return { exists: true, mtimeMs: -1 };
  }
}

async function takeSigs(paths: { files: string[]; dirs: string[] }): Promise<Pick<SettingsSnapshot, "files" | "dirs">> {
  const files: Record<string, FileSig> = {};
  const dirs: Record<string, DirSig> = {};
  for (const f of paths.files) files[f] = await sigOfFile(f);
  for (const d of paths.dirs) dirs[d] = await sigOfDir(d);
  return { files, dirs };
}

function sameSigs(a: SettingsSnapshot, b: Pick<SettingsSnapshot, "files" | "dirs">): boolean {
  return JSON.stringify({ files: a.files, dirs: a.dirs }) === JSON.stringify(b);
}

/** Load once and remember the stat of every watched file and directory. */
export async function snapshotSettings(input: LoadInput): Promise<SettingsSnapshot> {
  const paths = watchedSettingsPaths(input);
  // Signatures first: a write during the load then leaves signatures stale, which the next
  // poll recovers; signatures taken after the load would be ahead of it and never recover.
  const sigs = await takeSigs(paths);
  const loaded = await loadSettings(input);
  return { ...sigs, loaded };
}

function topKeys(settings: Settings): string[] {
  return Object.keys(settings as Record<string, unknown>);
}

function diffKeys(oldS: Settings, newS: Settings): Array<{ key: string; old: unknown; new: unknown }> {
  const out: Array<{ key: string; old: unknown; new: unknown }> = [];
  for (const key of new Set([...topKeys(oldS), ...topKeys(newS)])) {
    const o = (oldS as Record<string, unknown>)[key];
    const n = (newS as Record<string, unknown>)[key];
    if (JSON.stringify(o) !== JSON.stringify(n)) out.push({ key, old: o, new: n });
  }
  return out;
}

/** Re-stat everything; on a file change reload and apply policy keys, holding back model keys. */
export async function pollSettings(prev: SettingsSnapshot, input: LoadInput): Promise<ReloadResult> {
  const paths = watchedSettingsPaths(input);
  const sigs = await takeSigs(paths);
  if (sameSigs(prev, sigs)) {
    return {
      changed: false,
      snapshot: prev,
      loaded: prev.loaded,
      settings: prev.loaded.settings,
      notices: [],
      warnings: [],
      events: [],
      announced: [],
    };
  }
  let fresh: LoadedSettings;
  try {
    fresh = await loadSettings(input);
  } catch (err) {
    const problems: Problem[] =
      err !== null && typeof err === "object" && "problems" in err
        ? (err as { problems: Problem[] }).problems
        : [{ file: input.projectRoot, key: "", message: String(err) }];
    return {
      changed: false,
      snapshot: { ...sigs, loaded: prev.loaded },
      loaded: prev.loaded,
      settings: prev.loaded.settings,
      // One warning per edit (Q45): the problem is surfaced only in warnings, described with file, line and key.
      notices: [],
      warnings: problems,
      events: [],
      announced: [],
    };
  }
  const announced: string[] = [];
  const effective: Settings = { ...(fresh.settings as Settings) } as Settings;
  for (const key of MODEL_KEYS) {
    const o = (prev.loaded.settings as Record<string, unknown>)[key];
    const n = (fresh.settings as Record<string, unknown>)[key];
    if (JSON.stringify(o) !== JSON.stringify(n)) {
      announced.push(key);
      if (o === undefined) delete (effective as Record<string, unknown>)[key];
      else (effective as Record<string, unknown>)[key] = o;
    }
  }
  const applied = diffKeys(prev.loaded.settings, effective);
  const changedFiles = paths.files.filter(
    (f) => JSON.stringify((prev.files[f] ?? null) as unknown) !== JSON.stringify((sigs.files[f] ?? null) as unknown),
  );
  const changedDirs = paths.dirs.filter(
    (d) => JSON.stringify((prev.dirs[d] ?? null) as unknown) !== JSON.stringify((sigs.dirs[d] ?? null) as unknown),
  );
  const changedPaths = [...changedFiles, ...changedDirs];
  const events: SettingsChangeEvent[] = applied.map((d) => ({ ...d, source: "file" as const }));
  const notices: string[] = [];
  if (applied.length > 0) {
    const names = changedPaths.length > 0 ? changedPaths.join(", ") : "settings files";
    notices.push(`Settings updated from ${names}: ${applied.map((d) => d.key).join(", ")}`);
  } else if (changedPaths.length > 0 && announced.length === 0) {
    notices.push(`Settings reloaded from ${changedPaths.join(", ")} (no effective change)`);
  }
  for (const key of announced) {
    const o = JSON.stringify((prev.loaded.settings as Record<string, unknown>)[key] ?? null);
    const n = JSON.stringify((fresh.settings as Record<string, unknown>)[key] ?? null);
    notices.push(`Settings file wants ${key} ${n}, keeping ${o} (use /model or /effort, or confirm a new epoch)`);
  }
  const loaded: LoadedSettings = { ...fresh, settings: effective };
  return {
    changed: changedPaths.length > 0,
    snapshot: { ...sigs, loaded },
    loaded,
    settings: effective,
    notices,
    warnings: fresh.warnings,
    events,
    announced,
  };
}
