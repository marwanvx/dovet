// Sandbox init (permissions §7.1, ADR-6, SPIKE-16).
import { isAbsolute, join, relative, resolve } from "node:path";
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

export type SrtHelperFile = (typeof SRT_HELPER_FILES)[keyof typeof SRT_HELPER_FILES];

/** Which helper files belong in the archive of `os` (and so which the config below points at). */
export function srtHelpersFor(os: SandboxOs): SrtHelperFile[] {
  const files: SrtHelperFile[] = [SRT_HELPER_FILES.javaAgent];
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
  denyWrite?: string[];
  allowedDomains?: string[];
  deniedDomains?: string[];
  credentials?: SandboxRuntimeConfig["credentials"];
  allowLocalBinding?: boolean;
  enableWeakerNestedSandbox?: boolean;
  strictAllowlist?: boolean;
  /** Proxy ask callback for hosts outside the allowlist (permissions §7.4); absent denies them. */
  ask?: (params: { host: string; port: number | undefined }) => Promise<boolean>;
};

/**
 * The sandbox-runtime configuration with an explicit path for every helper file the OS uses. Throws if the helpers
 * sit inside a write grant (a sandboxed command could then replace them).
 */
export function sandboxRuntimeConfig(opts: SandboxStartOptions): SandboxRuntimeConfig {
  for (const dir of opts.allowWrite) {
    const rel = relative(resolve(dir), resolve(opts.srtDir));
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      throw new Error(`the sandbox helpers in ${opts.srtDir} are inside the write grant ${dir}`);
  }
  const helper = (name: string) => join(opts.srtDir, name);
  return {
    network: {
      allowedDomains: opts.allowedDomains ?? [],
      deniedDomains: opts.deniedDomains ?? [],
      ...(opts.strictAllowlist === undefined ? {} : { strictAllowlist: opts.strictAllowlist }),
      ...(opts.allowLocalBinding === undefined ? {} : { allowLocalBinding: opts.allowLocalBinding }),
    },
    filesystem: {
      denyRead: opts.denyRead ?? [],
      allowWrite: opts.allowWrite,
      denyWrite: opts.denyWrite ?? [],
    },
    ...(opts.credentials === undefined ? {} : { credentials: opts.credentials }),
    ...(opts.enableWeakerNestedSandbox === undefined
      ? {}
      : { enableWeakerNestedSandbox: opts.enableWeakerNestedSandbox }),
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
  const { ask, ...rest } = opts;
  await SandboxManager.initialize(sandboxRuntimeConfig(rest), ask);
  return SandboxManager;
}
