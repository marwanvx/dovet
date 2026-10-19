// Windows backend selection (permissions §7.6, ADR-6): MXC, then srt-windows, then none.
import { type SandboxBackend, type SandboxState, sandboxStatus } from "./service.ts";

export function selectWindowsBackend(opts: { mxcSupported: boolean; srtInstalled: boolean; mxcExecutable?: boolean }): {
  backend: SandboxBackend;
  reason: string;
} {
  if (opts.mxcSupported && opts.mxcExecutable === true) {
    return { backend: "mxc", reason: "MXC is available" };
  }
  if (opts.srtInstalled) {
    return { backend: "srt-windows", reason: "srt-win is installed" };
  }
  if (opts.mxcSupported) {
    return { backend: "mxc", reason: "MXC is available (execution pending)" };
  }
  return { backend: "none", reason: "no Windows backend is available" };
}

export function windowsStateFor(backend: SandboxBackend): SandboxState {
  if (backend === "srt-windows") return "experimental";
  return "off";
}

export function windowsStatusText(opts: { backend: SandboxBackend; state: SandboxState }): string {
  return sandboxStatus(opts.state, opts.backend);
}
