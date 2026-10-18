import type { AbsPath } from "../schema/index.ts";
import { createExecResolver } from "./exec.ts";
import { runHardenedGit } from "./git.ts";
import { libexecPath } from "./libexec.ts";
import { canonicalizePath } from "./paths.ts";
import { createProcessManager } from "./process.ts";
import { fileExists, resolveShell } from "./shell.ts";
import type { Os, Platform } from "./types.ts";

/** What exists so far; `shells()` and `clipboard` join in the tasks that build them (M1-20, M3). */
export type PlatformCore = Omit<Platform, "shells" | "clipboard"> & {
  /** AC-LOOP-09: ends every child tree and resolves once the SIGTERM→SIGKILL escalation has run (QUESTIONS Q64: core-only). */
  killTrees(): Promise<void>;
};

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
  const gitExecPath = async (): Promise<string | undefined> => {
    const git = await exec.resolve("git");
    if (git === undefined) return undefined;
    const out = await runHardenedGit({ git, cwd: projectRoot, env }, ["--exec-path"]);
    return out.code === 0 ? out.stdout.trim() : undefined;
  };
  return {
    os,
    arch,
    canonicalize: (p, cwd) => canonicalizePath(p, cwd, os),
    spawn: processes.spawn,
    killTree: processes.killTree,
    killTrees: processes.killTrees,
    sweep: processes.sweep,
    libexec: (name) => libexecPath(execPath, os, name),
    // ASSUMPTION (QUESTIONS Q18): Platform.resolve
    resolve: exec.resolve,
    resolveShell: (setting) =>
      resolveShell({ os, env, resolve: exec.resolve, exists: fileExists, gitExecPath }, setting),
  };
}
