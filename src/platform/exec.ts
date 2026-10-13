import { constants, realpathSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { AbsPath } from "../schema/index.ts";
import { isErrno } from "./errno.ts";
import { isWithin, windowsRefusal } from "./paths.ts";
import type { Os } from "./types.ts";

export type ExecResolver = { resolve(program: string): Promise<AbsPath | undefined> };

// Only real executables: a .bat or .cmd run through cmd.exe re-parses its arguments (shell injection).
const EXECUTABLE_EXTS = [".COM", ".EXE"];

/**
 * Finds programs on PATH for Dovet's own spawns. Skips `.`, empty and relative entries and any directory inside the
 * project, because Windows `CreateProcess` would run `git.exe` from a cloned repository's root (platforms "Executable
 * resolution"). Answers, including "missing", are cached for the life of the resolver.
 */
export function createExecResolver(deps: {
  os: Os;
  env: Readonly<Record<string, string | undefined>>;
  projectRoot: AbsPath;
}): ExecResolver {
  const { os, env, projectRoot } = deps;
  const impl = os === "win32" ? win32 : posix;
  const lookup = (name: string): string | undefined =>
    os === "win32" ? env[Object.keys(env).find((k) => k.toUpperCase() === name) ?? name] : env[name];
  const exts = (lookup("PATHEXT") ?? ".COM;.EXE")
    .toUpperCase()
    .split(";")
    .filter((e) => EXECUTABLE_EXTS.includes(e));
  const cache = new Map<string, Promise<AbsPath | undefined>>();
  let usableDirs: Promise<string[]> | undefined;

  function realOrUndefined(p: string): string | undefined {
    try {
      return realpathSync.native(p);
    } catch (e) {
      if (isErrno(e, "ENOENT", "ENOTDIR", "EACCES")) return undefined;
      throw e;
    }
  }

  async function computeUsableDirs(): Promise<string[]> {
    const project = realOrUndefined(projectRoot) ?? projectRoot;
    const dirs: string[] = [];
    for (const raw of (lookup("PATH") ?? "").split(impl.delimiter)) {
      const dir = os === "win32" ? raw.replace(/^"(.*)"$/, "$1") : raw;
      if (dir === "" || dir === "." || !impl.isAbsolute(dir)) continue;
      if (os === "win32" && windowsRefusal(dir) !== undefined) continue;
      if (isWithin(dir, projectRoot, os) || isWithin(dir, project, os)) continue;
      const real = realOrUndefined(dir);
      if (real === undefined || isWithin(real, project, os) || isWithin(real, projectRoot, os)) continue;
      dirs.push(dir);
    }
    return dirs;
  }

  async function isRunnable(file: string): Promise<boolean> {
    try {
      if (!(await stat(file)).isFile()) return false;
      if (os !== "win32") await access(file, constants.X_OK);
      return true;
    } catch (e) {
      if (isErrno(e, "ENOENT", "ENOTDIR", "EACCES")) return false;
      throw e;
    }
  }

  async function find(program: string): Promise<AbsPath | undefined> {
    usableDirs ??= computeUsableDirs();
    const hasKnownExt = exts.some((e) => program.toUpperCase().endsWith(e.toUpperCase()));
    const names = os === "win32" && !hasKnownExt ? exts.map((e) => program + e) : [program];
    for (const dir of await usableDirs) {
      for (const name of names) {
        const file = impl.join(dir, name);
        if (await isRunnable(file)) return file;
      }
    }
    return undefined;
  }

  return {
    resolve(program) {
      if (program === "" || /[\\/]/.test(program)) {
        return Promise.reject(new Error(`resolve() takes a bare program name, got "${program}"`));
      }
      let found = cache.get(program);
      if (found === undefined) {
        found = find(program).catch((e: unknown) => {
          cache.delete(program);
          throw e;
        });
        cache.set(program, found);
      }
      return found;
    },
  };
}
