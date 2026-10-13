import { posix, win32 } from "node:path";
import type { AbsPath } from "../schema/index.ts";
import type { Os } from "./types.ts";

export type Dirs = { config: AbsPath; data: AbsPath; cache: AbsPath };
type Env = Readonly<Record<string, string | undefined>>;

/** Config, data and cache directories (cli-config "Directories"). */
export function resolveDirs(input: { os: Os; home: string; env: Env }): Dirs {
  const { os, home, env } = input;
  const p = os === "win32" ? win32 : posix;
  const set = (name: string): string | undefined => (env[name] === "" ? undefined : env[name]);
  const rooted = (v: string): boolean => (os === "win32" ? /^[A-Za-z]:[\\/]/.test(v) : p.isAbsolute(v));
  const absolute = (name: string): string | undefined => {
    const v = set(name);
    return v !== undefined && rooted(v) ? v : undefined;
  };
  const override = (name: string): string | undefined => {
    const v = set(name);
    if (v !== undefined && !rooted(v)) throw new Error(`${name} must be an absolute path (got "${v}")`);
    return v;
  };

  let config: string;
  let data: string;
  let cache: string;
  if (os === "win32") {
    config = p.join(absolute("APPDATA") ?? p.join(home, "AppData", "Roaming"), "dovet");
    data = p.join(absolute("LOCALAPPDATA") ?? p.join(home, "AppData", "Local"), "dovet");
    cache = p.join(data, "cache");
  } else if (os === "darwin") {
    config = p.join(home, ".config", "dovet");
    data = p.join(home, "Library", "Application Support", "dovet");
    cache = p.join(home, "Library", "Caches", "dovet");
  } else {
    config = p.join(absolute("XDG_CONFIG_HOME") ?? p.join(home, ".config"), "dovet");
    data = p.join(absolute("XDG_DATA_HOME") ?? p.join(home, ".local", "share"), "dovet");
    cache = p.join(absolute("XDG_CACHE_HOME") ?? p.join(home, ".cache"), "dovet");
  }

  const configOverride = override("DOVET_CONFIG_DIR");
  const dataOverride = override("DOVET_DATA_DIR");
  return {
    config: configOverride ?? config,
    data: dataOverride ?? data,
    // ASSUMPTION (QUESTIONS Q18): the cache follows DOVET_DATA_DIR
    cache: dataOverride === undefined ? cache : p.join(dataOverride, "cache"),
  };
}
