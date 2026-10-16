// dovet sandbox install/uninstall/status (cli-config). No process.* here; main.ts wires it.
import { type SandboxBackend, type SandboxState, sandboxStatus } from "../policy/index.ts";

export function sandboxStatusText(opts: { os: string; backend: SandboxBackend; state: SandboxState }): string {
  return `os: ${opts.os}\n${sandboxStatus(opts.state, opts.backend)}`;
}

export type SandboxDeps = {
  os: string;
  backend: SandboxBackend;
  state: SandboxState;
  check(): Promise<{ provisioned: boolean; detail: string }>;
  install(): Promise<{ cancelled?: boolean }>;
  uninstall(): Promise<{ cancelled?: boolean }>;
};

export async function runSandboxCommand(
  argv: readonly string[],
  deps: SandboxDeps,
): Promise<{ output: string; exitCode: number }> {
  const [sub] = argv;
  if (sub === "status") {
    const base = sandboxStatusText({ os: deps.os, backend: deps.backend, state: deps.state });
    if (deps.os !== "win32") return { output: `${base}\n`, exitCode: 0 };
    const s = await deps.check();
    return {
      output: `${base}\nsandbox user: ${s.provisioned ? "installed" : "not installed"} (${s.detail})\n`,
      exitCode: 0,
    };
  }
  if (sub === "install" || sub === "uninstall") {
    if (deps.os !== "win32") return { output: `dovet sandbox ${sub} is Windows only\n`, exitCode: 2 };
    const r = sub === "install" ? await deps.install() : await deps.uninstall();
    if (r.cancelled === true) return { output: `${sub} cancelled (UAC dismissed)\n`, exitCode: 1 };
    return { output: `${sub} done\n`, exitCode: 0 };
  }
  return { output: "usage: dovet sandbox <install|uninstall|status>\n", exitCode: 2 };
}
