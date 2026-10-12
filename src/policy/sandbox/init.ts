// Sandbox initialization (permissions §7.1, ADR-6): sandbox-runtime gets every helper by explicit path into the
// install directory's `libexec/srt/`, so nothing is looked up relative to a `node_modules` that a compiled binary
// doesn't have (SPIKE-16).
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export type SandboxOs = "linux" | "darwin" | "win32";

/** The files of sandbox-runtime's `vendor/` that Dovet ships, by name inside `libexec/srt/`. */
export const SRT_HELPER_FILES = {
  /** Linux: applies the seccomp filter that blocks creating Unix sockets, inside the bubblewrap sandbox. */
  seccomp: "apply-seccomp",
  /** All OSes: makes Java honour the sandbox proxy settings. */
  javaAgent: "srt-proxy-agent.jar",
  /** Windows: the backend helper (dedicated sandbox user, firewall rules, file ACLs). */
  srtWin: "srt-win.exe",
} as const;

/** Which helper files belong in the archive of `os` (and so which the config below points at). */
export function srtHelpersFor(os: SandboxOs): (typeof SRT_HELPER_FILES)[keyof typeof SRT_HELPER_FILES][] {
  const files: (typeof SRT_HELPER_FILES)[keyof typeof SRT_HELPER_FILES][] = [SRT_HELPER_FILES.javaAgent];
  if (os === "linux") files.push(SRT_HELPER_FILES.seccomp);
  if (os === "win32") files.push(SRT_HELPER_FILES.srtWin);
  return files;
}

export type SandboxStartOptions = {
  os: SandboxOs;
  /** `libexec/srt/` of the install directory (`libexecPath(execPath, os, "srt")`). */
  srtDir: string;
  /** Bundled ripgrep (`libexecPath(execPath, os, "rg")`), or undefined to use `rg` from PATH. */
  rgPath?: string | undefined;
  allowWrite: string[];
  denyRead?: string[];
  allowedDomains?: string[];
};

/** The sandbox-runtime configuration with an explicit path for every helper file the OS uses. */
export function sandboxRuntimeConfig(opts: SandboxStartOptions): SandboxRuntimeConfig {
  const helper = (name: string) => join(opts.srtDir, name);
  return {
    network: { allowedDomains: opts.allowedDomains ?? [], deniedDomains: [] },
    filesystem: { denyRead: opts.denyRead ?? [], allowWrite: opts.allowWrite, denyWrite: [] },
    javaAgentJarPath: helper(SRT_HELPER_FILES.javaAgent),
    ...(opts.rgPath ? { ripgrep: { command: opts.rgPath } } : {}),
    ...(opts.os === "linux" ? { seccomp: { applyPath: helper(SRT_HELPER_FILES.seccomp) } } : {}),
    ...(opts.os === "win32" ? { windows: { srtWin: { path: helper(SRT_HELPER_FILES.srtWin) } } } : {}),
  };
}

/**
 * Starts sandbox-runtime's proxies and checks the platform. sandbox-runtime keeps one manager per process, so call
 * this once; the caller owns the result and ends it with `SandboxManager.reset()`.
 */
export async function startSandbox(opts: SandboxStartOptions): Promise<typeof SandboxManager> {
  await SandboxManager.initialize(sandboxRuntimeConfig(opts));
  return SandboxManager;
}
