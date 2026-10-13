import type { AbsPath } from "../schema/index.ts";
import { createExecResolver } from "./exec.ts";
import { libexecPath } from "./libexec.ts";
import { canonicalizePath } from "./paths.ts";
import { createProcessManager } from "./process.ts";
import type { Os, Platform } from "./types.ts";

/** What exists so far; `shells()` and `clipboard` join in the tasks that build them (M1-20, M3). */
export type PlatformCore = Omit<Platform, "shells" | "clipboard">;

export function createPlatformCore(deps: {
  os: Os;
  arch: string;
  /** Real path of the running executable (symlinks resolved). */
  execPath: string;
  env: Readonly<Record<string, string | undefined>>;
  projectRoot: AbsPath;
  /** `process.kill`, passed in by `cli/main.ts`: only that file touches `process.*`. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  termGraceMs?: number;
}): PlatformCore {
  const { os, arch, execPath, env, projectRoot } = deps;
  const exec = createExecResolver({ os, env, projectRoot });
  const processes = createProcessManager({ os, env, kill: deps.kill, termGraceMs: deps.termGraceMs ?? 3000 });
  return {
    os,
    arch,
    canonicalize: (p, cwd) => canonicalizePath(p, cwd, os),
    spawn: processes.spawn,
    killTree: processes.killTree,
    libexec: (name) => libexecPath(execPath, os, name),
    // ASSUMPTION (QUESTIONS Q18): Platform.resolve
    resolve: exec.resolve,
  };
}
