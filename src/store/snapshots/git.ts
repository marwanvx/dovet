// Running git without letting the user's repository or configuration run anything (checkpoints "Git tree snapshots",
// ADR-19). Every call gets the same hardening flags and a scrubbed environment; only plumbing commands are used.
import { mkdirSync } from "node:fs";

export type Env = Readonly<Record<string, string | undefined>>;

/** What every git call of one snapshotter shares. */
export interface GitContext {
  /** Working directory: the top level of the repository. */
  readonly cwd: string;
  /** The caller's environment with every `GIT_*` variable removed, plus `GIT_OPTIONAL_LOCKS=0`. */
  readonly env: Readonly<Record<string, string>>;
  /** An empty directory used as `core.hooksPath`, so no hook can run. */
  readonly hooksDir: string;
}

/** `base` without `GIT_*` variables (case-insensitive, for Windows) and without undefined values. */
export function scrubbedEnv(base: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.toUpperCase().startsWith("GIT_")) continue;
    out[key] = value;
  }
  out.GIT_OPTIONAL_LOCKS = "0";
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

export function emptyDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Runs one git command and returns its stdout bytes; a non-zero exit throws with git's own message. */
export async function runGit(
  ctx: GitContext,
  args: readonly string[],
  options: { env?: Readonly<Record<string, string>>; input?: Uint8Array } = {},
): Promise<Uint8Array> {
  const argv = [
    "git",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${ctx.hooksDir}`,
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    ...args,
  ];
  const proc = Bun.spawn(argv, {
    cwd: ctx.cwd,
    env: { ...ctx.env, ...options.env },
    stdin: options.input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited with ${code}: ${stderr.trim()}`);
  return stdout;
}

/** Splits NUL-terminated output into its entries. */
export function splitNul(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** Splits newline-terminated output into its non-empty lines. */
export function lines(bytes: Uint8Array): string[] {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((l) => l !== "");
}
