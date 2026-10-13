import { posix, win32 } from "node:path";
import { isErrno } from "./errno.ts";
import type { ChildHandle, Os, Platform } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Spawns children as leaders of their own process group and kills whole trees (platforms "Process-tree kill").
 * `group` names a set of children (one per session); `killTree(group)` ends them and everything they started.
 */
export function createProcessManager(deps: {
  os: Os;
  env: Env;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  termGraceMs: number;
}): Pick<Platform, "spawn" | "killTree"> {
  const { os, env, kill, termGraceMs } = deps;
  const groups = new Map<string, Set<number>>();

  function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
      kill(-pid, signal);
      return true;
    } catch (e) {
      // macOS answers EPERM for a group that holds only zombies: nothing left to signal.
      if (isErrno(e, "ESRCH", "EPERM")) return false;
      throw e;
    }
  }

  async function killPosix(pid: number): Promise<void> {
    if (!signalGroup(pid, "SIGTERM")) return;
    const deadline = Date.now() + termGraceMs;
    while (Date.now() < deadline) {
      await Bun.sleep(25);
      if (!signalGroup(pid, 0)) return;
    }
    signalGroup(pid, "SIGKILL");
  }

  function isRunning(pid: number): boolean {
    try {
      kill(pid, 0);
      return true;
    } catch (e) {
      if (isErrno(e, "ESRCH")) return false;
      throw e;
    }
  }

  async function killWindows(pid: number): Promise<void> {
    const root = env[Object.keys(env).find((k) => k.toUpperCase() === "SYSTEMROOT") ?? "SystemRoot"] ?? "C:\\Windows";
    const taskkill = Bun.spawn({
      cmd: [win32.join(root, "System32", "taskkill.exe"), "/T", "/F", "/PID", String(pid)],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, , stderr] = await Promise.all([
      taskkill.exited,
      new Response(taskkill.stdout).text(),
      new Response(taskkill.stderr).text(),
    ]);
    if (code !== 0 && isRunning(pid)) throw new Error(`taskkill /PID ${pid} failed (exit ${code}): ${stderr.trim()}`);
  }

  const killPid = (pid: number): Promise<void> => (os === "win32" ? killWindows(pid) : killPosix(pid));

  return {
    spawn(cmd): ChildHandle {
      const program = cmd.argv[0];
      const absolute = os === "win32" ? win32.isAbsolute : posix.isAbsolute;
      if (program === undefined || !absolute(program)) {
        throw new Error(`spawn: "${program ?? ""}" is not an absolute path; resolve the program first`);
      }
      cmd.signal.throwIfAborted();
      const childEnv =
        os === "win32"
          ? {
              ...Object.fromEntries(
                Object.entries(cmd.env).filter(([k]) => k.toUpperCase() !== "NODEFAULTCURRENTDIRECTORYINEXEPATH"),
              ),
              NoDefaultCurrentDirectoryInExePath: "1",
            }
          : cmd.env;
      const proc = Bun.spawn({
        cmd: cmd.argv,
        cwd: cmd.cwd,
        env: childEnv,
        stdin: cmd.stdin === undefined || cmd.stdin === "null" ? "ignore" : Buffer.from(cmd.stdin),
        stdout: "pipe",
        stderr: "pipe",
        detached: os !== "win32",
      });
      const pid = proc.pid;
      const members = groups.get(cmd.group) ?? new Set<number>();
      if (os !== "win32") for (const old of members) if (!signalGroup(old, 0)) members.delete(old);
      members.add(pid);
      groups.set(cmd.group, members);

      let failKill: (e: unknown) => void = () => {};
      const killFailed = new Promise<never>((_, reject) => {
        failKill = reject;
      });
      const onAbort = (): void => {
        killPid(pid).catch(failKill);
      };
      cmd.signal.addEventListener("abort", onAbort, { once: true });
      const exited = proc.exited.then((): number | null => {
        cmd.signal.removeEventListener("abort", onAbort);
        if (os === "win32" || !signalGroup(pid, 0)) members.delete(pid);
        return proc.exitCode;
      });
      return { pid, stdout: proc.stdout, stderr: proc.stderr, exited: Promise.race([exited, killFailed]) };
    },

    async killTree(group) {
      const members = groups.get(group);
      if (members === undefined) return;
      groups.delete(group);
      await Promise.all([...members].map(killPid));
    },
  };
}
