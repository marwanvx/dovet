// Finding and stopping processes a command left behind (tools §5.5): members of its process group, and escapees that still carry its DOVET_RUN marker.
import { readdir, readFile } from "node:fs/promises";
import { isErrno } from "./errno.ts";
import type { Os } from "./types.ts";

export type Straggler = { pid: number; name: string };
type Entry = Straggler & { pgid: number; marked: boolean };

const MAX_NAME = 60;
const clip = (s: string): string => (s.length > MAX_NAME ? `${s.slice(0, MAX_NAME)}…` : s);

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    // The process ended meanwhile (ENOENT/ESRCH), or belongs to another user (EACCES/EPERM).
    if (isErrno(e, "ENOENT", "ESRCH", "EACCES", "EPERM")) return undefined;
    throw e;
  }
}

async function linuxTable(marker: string): Promise<Entry[]> {
  const pids = (await readdir("/proc")).filter((n) => /^\d+$/.test(n));
  const entries = await Promise.all(
    pids.map(async (n): Promise<Entry | undefined> => {
      const stat = await readOptional(`/proc/${n}/stat`);
      if (stat === undefined) return undefined;
      // `pid (comm) state ppid pgrp …`: comm may hold spaces and parentheses, so split after the last ")".
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (rest[0] === "Z" || rest[0] === "X") return undefined;
      const environ = await readOptional(`/proc/${n}/environ`);
      const cmdline = (await readOptional(`/proc/${n}/cmdline`)) ?? "";
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      return {
        pid: Number(n),
        pgid: Number(rest[2]),
        name: clip(cmdline.split("\0").join(" ").trim() || comm),
        marked: environ !== undefined && `\0${environ}`.includes(`\0${marker}\0`),
      };
    }),
  );
  return entries.filter((e): e is Entry => e !== undefined);
}

async function psLines(args: string[]): Promise<string[]> {
  const ps = Bun.spawn({ cmd: ["ps", ...args], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(ps.stdout).text(),
    new Response(ps.stderr).text(),
    ps.exited,
  ]);
  if (code !== 0) throw new Error(`ps ${args.join(" ")} exited with ${code}: ${err.trim()}`);
  return out.split("\n").filter((l) => l.trim() !== "");
}

async function darwinTable(marker: string): Promise<Entry[]> {
  const [plain, withEnv] = await Promise.all([
    psLines(["-A", "-ww", "-o", "pid=,pgid=,stat=,command="]),
    psLines(["eww", "-A", "-o", "pid=,command="]),
  ]);
  const marked = new Set(
    withEnv.filter((l) => ` ${l}`.includes(` ${marker}`)).map((l) => Number(l.trim().split(/\s+/)[0])),
  );
  const entries: Entry[] = [];
  for (const line of plain) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m === null || m[3]?.startsWith("Z")) continue;
    entries.push({
      pid: Number(m[1]),
      pgid: Number(m[2]),
      name: clip((m[4] ?? "").trim()),
      marked: marked.has(Number(m[1])),
    });
  }
  return entries;
}

/**
 * Stops everything of a finished command that is still alive: processes in `pgids` (its process group) and, on Linux
 * and macOS, escapees whose environment holds `marker` (`DOVET_RUN=<id>`). SIGTERM, then SIGKILL after `termGraceMs`.
 */
export async function sweepStragglers(deps: {
  os: Os;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  termGraceMs: number;
  pgids: readonly number[];
  marker: string;
}): Promise<Straggler[]> {
  const { os, kill, pgids, marker } = deps;
  if (os === "win32") return [];
  const find = async (): Promise<Entry[]> =>
    (os === "linux" ? await linuxTable(marker) : await darwinTable(marker)).filter(
      (e) => e.marked || pgids.includes(e.pgid),
    );
  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      kill(pid, sig);
    } catch (e) {
      if (!isErrno(e, "ESRCH", "EPERM")) throw e;
    }
  };
  const found = await find();
  if (found.length === 0) return [];
  for (const e of found) signal(e.pid, "SIGTERM");
  const deadline = Date.now() + deps.termGraceMs;
  let left = found;
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(25);
    const alive = new Set((await find()).map((e) => e.pid));
    left = left.filter((e) => alive.has(e.pid));
  }
  for (const e of left) signal(e.pid, "SIGKILL");
  return found.map(({ pid, name }) => ({ pid, name }));
}
