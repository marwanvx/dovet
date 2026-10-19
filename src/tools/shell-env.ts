// The environment Bash commands run in (tools §5.2–5.3, permissions §8, cli-config "env"): the login-shell snapshot, settings `env`, additions and the secret scrub.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Os, Platform } from "../platform/index.ts";
import { parseEnvFile, SECRET_NAME } from "../policy/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { collectOutput } from "./child-output.ts";

export { parseEnvFile, SECRET_NAME };

type Env = Readonly<Record<string, string | undefined>>;

const VOLATILE = /^(PWD|OLDPWD|SHLVL|_|PS[1-4]|PROMPT_COMMAND|TERM_SESSION_ID|HISTFILE|ZSH_.*|P9K_.*|POWERLEVEL9K_.*)$/;
const ENTRY = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const SNAPSHOT_TIMEOUT_MS = 10_000;

function defined(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

/** Parses `env -0` output. Text an rc file printed before the first variable is dropped. */
export function parseEnvZ(raw: string, os: Os): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = raw.split("\0");
  entries.forEach((entry, i) => {
    let item = entry;
    if (i === 0 && !ENTRY.test(item)) item = /(?:^|\n)([A-Za-z_][A-Za-z0-9_]*=[\s\S]*)$/.exec(item)?.[1] ?? "";
    if (!ENTRY.test(item)) return;
    const eq = item.indexOf("=");
    const name = item.slice(0, eq);
    if (VOLATILE.test(name) || SECRET_NAME.test(name)) return;
    if (os === "win32" && name.toUpperCase() === "PATH") return;
    result[name] = item.slice(eq + 1);
  });
  return result;
}

export type SnapshotResult = { env: Record<string, string> | null; note?: string };
export type ShellSnapshot = { ready(): Promise<SnapshotResult> };

const RC: Record<string, string> = { bash: "~/.bashrc", zsh: "~/.zshrc", fish: "~/.config/fish/config.fish" };

/** Starts capturing the user's login-shell environment in the background; `ready()` resolves when it is done or timed out. */
export function startShellSnapshot(deps: {
  platform: Pick<Platform, "os" | "spawn" | "killTree">;
  userShell: AbsPath;
  cwd: AbsPath;
  env: Env;
  sessionDir: string;
  group: string;
  timeoutMs?: number;
}): ShellSnapshot {
  const { platform, userShell, env } = deps;
  const timeoutMs = deps.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  const rc = RC[basename(userShell)] ?? "your shell setup";

  async function capture(): Promise<SnapshotResult> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      let out: Awaited<ReturnType<typeof collectOutput>>;
      try {
        out = await collectOutput(
          platform.spawn({
            argv: [userShell, "-l", "-i", "-c", "env -0"],
            cwd: deps.cwd,
            env: { ...defined(env), DOVET_SNAPSHOT: "1" },
            stdin: "null",
            signal: abort.signal,
            group: deps.group,
          }),
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return { env: null, note: `Shell setup (${rc}) could not be run (${reason}); using Dovet's own environment.` };
      }
      if (abort.signal.aborted) {
        return {
          env: null,
          note: `Shell setup (${rc}) didn't finish in ${Math.round(timeoutMs / 1000)} s; using Dovet's own environment. Set DOVET_SNAPSHOT checks in your rc or run /doctor.`,
        };
      }
      const captured = parseEnvZ(out.stdout.toString("utf8"), platform.os);
      if (out.code !== 0 || Object.keys(captured).length === 0) {
        return {
          env: null,
          note: `Shell setup (${rc}) could not be read (exit ${out.code}); using Dovet's own environment.`,
        };
      }
      await mkdir(deps.sessionDir, { recursive: true, mode: 0o700 });
      await writeFile(join(deps.sessionDir, "shell-env.json"), JSON.stringify(captured), { mode: 0o600 });
      return { env: captured };
    } finally {
      clearTimeout(timer);
      await platform.killTree(deps.group);
    }
  }

  const pending = capture();
  return { ready: () => pending };
}

export function commandEnv(deps: {
  os: Os;
  launch: Env;
  snapshot: Readonly<Record<string, string>> | null;
  envFile?: Readonly<Record<string, string>>;
  settingsEnv?: Readonly<Record<string, string>> | undefined;
  passEnv?: readonly string[] | undefined;
}): { env: Record<string, string>; ignored: string[] } {
  const { os, launch } = deps;
  const env: Record<string, string> = { ...defined(launch), ...deps.snapshot, ...deps.envFile };
  const fold = (k: string): string => (os === "win32" ? k.toUpperCase() : k);
  const launched = new Set(Object.keys(defined(launch)).map(fold));
  const ignored: string[] = [];
  for (const [name, value] of Object.entries(deps.settingsEnv ?? {})) {
    if (launched.has(fold(name))) ignored.push(name);
    else env[name] = value;
  }
  const pass = new Set(deps.passEnv ?? []);
  for (const name of Object.keys(env)) if (SECRET_NAME.test(name) && !pass.has(name)) delete env[name];
  delete env.BUN_OPTIONS;
  delete env.BUN_BE_BUN;
  Object.assign(env, {
    DOVET: "1",
    AI_AGENT: "dovet",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    PYTHONUNBUFFERED: "1",
    ...(os === "win32" ? { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } : {}),
  });
  if (os === "win32" && env.LANG === undefined) env.LANG = "C.UTF-8";
  return { env, ignored };
}
