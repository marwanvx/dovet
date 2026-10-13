// Hardening shared by every git call Dovet makes itself (platforms "Dovet's own git calls").
import type { AbsPath } from "../schema/index.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Put before the subcommand. Empty `credential.helper` and `core.askPass` drop every configured helper and askpass. */
export const GIT_HARDENING_ARGS: readonly string[] = [
  "--no-optional-locks",
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
  "-c",
  "core.fsmonitor=false",
];

/** `base` without `GIT_*` (trace, askpass, alternate dirs) or `SSH_ASKPASS`, plus the no-fetch, no-prompt settings. */
export function hardenedGitEnv(base: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper.startsWith("GIT_") || upper === "SSH_ASKPASS" || upper === "GCM_INTERACTIVE") {
      continue;
    }
    out[key] = value;
  }
  out.GIT_OPTIONAL_LOCKS = "0";
  out.GIT_NO_LAZY_FETCH = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  out.GCM_INTERACTIVE = "never";
  return out;
}

export type GitCall = { git: AbsPath; cwd: AbsPath; env: Env };

export async function runHardenedGit(
  call: GitCall,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([call.git, ...GIT_HARDENING_ARGS, ...args], {
    cwd: call.cwd,
    env: hardenedGitEnv(call.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export type GitHead = { kind: "branch"; name: string } | { kind: "detached"; commit: string };

/** The repository state for the environment block, from plumbing only: `git status` would run clean filters. */
export async function readGitHead(call: GitCall): Promise<GitHead | null> {
  const inside = await runHardenedGit(call, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;
  const branch = await runHardenedGit(call, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch.code === 0) return { kind: "branch", name: branch.stdout.trim() };
  const commit = await runHardenedGit(call, ["rev-parse", "--short", "HEAD"]);
  if (commit.code !== 0) throw new Error(`git rev-parse HEAD exited with ${commit.code}: ${commit.stderr.trim()}`);
  return { kind: "detached", commit: commit.stdout.trim() };
}
