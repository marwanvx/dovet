// Shell selection (platforms "Windows specifics"): Git Bash first, then pwsh, then Windows PowerShell 5.1.
import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import type { AbsPath } from "../schema/index.ts";
import { isErrno } from "./errno.ts";
import type { Os, ShellChoice, ShellSetting } from "./types.ts";

export type ShellDeps = {
  os: Os;
  env: Readonly<Record<string, string | undefined>>;
  resolve(program: string): Promise<AbsPath | undefined>;
  exists(path: string): Promise<boolean>;
  /** `git --exec-path`, or undefined without git. */
  gitExecPath(): Promise<string | undefined>;
};

export const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch (e) {
    if (isErrno(e, "ENOENT", "ENOTDIR", "EACCES")) return false;
    throw e;
  }
};

function lookup(env: ShellDeps["env"], name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Never `C:\Windows\System32\bash.exe`: that is WSL's launcher, so only these locations are tried. */
async function findGitBash(deps: ShellDeps, configured: string | undefined): Promise<AbsPath | undefined> {
  const candidates: string[] = [];
  const add = (p: string | undefined): void => {
    if (p !== undefined && p !== "") candidates.push(p);
  };
  add(lookup(deps.env, "DOVET_GIT_BASH_PATH"));
  add(configured);
  const exec = await deps.gitExecPath();
  if (exec !== undefined) add(win32.resolve(exec, "..", "..", "..", "bin", "bash.exe"));
  const programFiles = lookup(deps.env, "ProgramFiles");
  if (programFiles !== undefined) add(win32.join(programFiles, "Git", "bin", "bash.exe"));
  const localAppData = lookup(deps.env, "LocalAppData");
  if (localAppData !== undefined) add(win32.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  for (const c of candidates) {
    if (win32.isAbsolute(c) && !/\\windows\\(system32|sysnative)\\/i.test(win32.normalize(c)) && (await deps.exists(c)))
      return c as AbsPath;
  }
  return undefined;
}

async function findPowerShell(deps: ShellDeps): Promise<ShellChoice | undefined> {
  const pwsh = await deps.resolve("pwsh");
  if (pwsh !== undefined) return { kind: "powershell", path: pwsh, edition: "pwsh" };
  const windows = await deps.resolve("powershell");
  return windows === undefined ? undefined : { kind: "powershell", path: windows, edition: "windows" };
}

export async function resolveShell(deps: ShellDeps, setting: ShellSetting = {}): Promise<ShellChoice | undefined> {
  if (deps.os !== "win32") {
    const bash = await deps.resolve("bash");
    return bash === undefined ? undefined : { kind: "bash", path: bash };
  }
  const mode = setting.windows ?? "auto";
  if (mode !== "powershell") {
    const gitBash = await findGitBash(deps, setting.gitBashPath);
    if (gitBash !== undefined) return { kind: "git-bash", path: gitBash };
  }
  const powershell = await findPowerShell(deps);
  if (powershell !== undefined && mode === "git-bash") {
    return { ...powershell, note: "shell.windows is git-bash but Git Bash was not found; using PowerShell." };
  }
  return powershell;
}
