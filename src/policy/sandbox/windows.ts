// Windows backend selection (permissions §7.6, ADR-6): MXC, then srt-windows, then none.
import { type SandboxBackend, type SandboxState, sandboxStatus } from "./service.ts";

export function selectWindowsBackend(opts: { mxcSupported: boolean; srtInstalled: boolean }): {
  backend: SandboxBackend;
  reason: string;
} {
  if (opts.mxcSupported) return { backend: "mxc", reason: "MXC is available" };
  if (opts.srtInstalled) return { backend: "srt-windows", reason: "srt-win is installed" };
  return { backend: "none", reason: "no Windows backend is available" };
}

export function windowsStatusText(opts: { backend: SandboxBackend; state: SandboxState }): string {
  return sandboxStatus(opts.state, opts.backend);
}
