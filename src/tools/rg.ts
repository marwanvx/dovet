// Running ripgrep for Grep and Glob (tools §7, §8): locating it, limits, error classification, ignore handling.
import { access, constants } from "node:fs/promises";
import { basename, dirname, posix, win32 } from "node:path";
import { isErrno, isWithin } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { sensitiveGlobs } from "./sensitive-files.ts";
import type { ToolContext, ToolOutput } from "./types.ts";

export type RgLimits = { timeoutMs: number; maxBytes: number };
export const DEFAULT_LIMITS: RgLimits = { timeoutMs: 20_000, maxBytes: 20 * 1024 * 1024 };

export type RgRun = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  capped: boolean;
  interrupted: boolean;
};

const VCS_EXCLUDE = ["--glob", "!{.git,.hg,.svn,.jj,.sl}"];
const MAX_STDERR = 64 * 1024;

export const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });

const MISSING_RG =
  "ripgrep (rg) was not found. Dovet ships it in libexec/ beside the executable; reinstall Dovet, or on Alpine Linux install it with `apk add ripgrep`.";

export type RgBinary = { path: AbsPath; note?: string };

export async function locateRg(ctx: ToolContext): Promise<RgBinary | ToolOutput> {
  const bundled = ctx.platform.libexec("rg");
  try {
    await access(bundled, constants.X_OK);
    return { path: bundled };
  } catch (e) {
    if (!isErrno(e, "ENOENT", "ENOTDIR", "EACCES")) throw e;
  }
  const onPath = await ctx.platform.resolve("rg");
  if (onPath === undefined) return fail(MISSING_RG);
  return { path: onPath, note: `(The bundled ripgrep is missing; used rg from PATH: ${onPath}.)` };
}

export const isBinary = (found: RgBinary | ToolOutput): found is RgBinary => "path" in found;

/** Flags both tools share: hidden files, ignore files without a git repository, VCS metadata and sensitive files excluded. */
export function baseArgs(ctx: ToolContext, noIgnore: boolean): string[] {
  const globs = sensitiveGlobs(ctx.settings).flatMap((g) => ["--glob", `!${g}`]);
  return [
    "--no-config",
    "--hidden",
    "--no-require-git",
    ...(noIgnore ? ["--no-ignore"] : []),
    ...VCS_EXCLUDE,
    ...globs,
  ];
}

function childEnv(env: ToolContext["env"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

async function drain(stream: ReadableStream<Uint8Array>, limit: number, onOverflow: () => void): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > limit) {
      onOverflow();
      break;
    }
  }
  return Buffer.concat(chunks);
}

/** Resolves to the run, or to an error output when ripgrep could not be started. */
export async function runRg(
  ctx: ToolContext,
  rg: AbsPath,
  args: readonly string[],
  cwd: AbsPath,
  limits: RgLimits,
  stderrLimit = MAX_STDERR,
): Promise<RgRun | ToolOutput> {
  if (ctx.signal.aborted)
    return { stdout: "", stderr: "", exitCode: null, timedOut: false, capped: false, interrupted: true };
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  let capped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeoutMs);
  try {
    let child: ReturnType<ToolContext["platform"]["spawn"]>;
    try {
      child = ctx.platform.spawn({
        argv: [rg, ...args],
        cwd,
        env: childEnv(ctx.env),
        stdin: "null",
        signal: controller.signal,
        group: `search-${ctx.session.id}`,
      });
    } catch (e) {
      return fail(`Could not start ripgrep: ${e instanceof Error ? e.message : String(e)}`);
    }
    const overflow = (): void => {
      capped = true;
      controller.abort();
    };
    const [out, err, exitCode] = await Promise.all([
      drain(child.stdout, limits.maxBytes, overflow),
      drain(child.stderr, stderrLimit, () => undefined),
      child.exited,
    ]);
    return {
      stdout: out.toString("utf8"),
      stderr: err.toString("utf8"),
      exitCode,
      timedOut,
      capped,
      interrupted: ctx.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

export const isRun = (r: RgRun | ToolOutput): r is RgRun => "stdout" in r;

export function stderrReport(stderr: string): { unreadable: number; fatal: string | undefined } {
  const lines = stderr.split("\n").filter((l) => l.trim() !== "");
  const other = lines.filter((l) => !/\(os error \d+\)\s*$/.test(l));
  return { unreadable: lines.length - other.length, fatal: other.length > 0 ? other.join("\n") : undefined };
}

/** An error output when the run failed, so a failure is never reported as "no matches". */
export function runFailure(run: RgRun): ToolOutput | undefined {
  if (run.interrupted) return { status: "interrupted", content: [{ kind: "text", text: "Search interrupted." }] };
  if (run.timedOut || run.capped) return undefined;
  const { fatal } = stderrReport(run.stderr);
  if (run.exitCode === 2 && fatal !== undefined) return fail(`ripgrep failed:\n${fatal}`);
  if (run.exitCode === 2 && run.stderr.trim() === "") return fail("ripgrep exited with code 2 and no message.");
  if (run.exitCode === null)
    return fail(`ripgrep was killed before it finished.${run.stderr ? `\n${run.stderr.trim()}` : ""}`);
  if (run.exitCode > 2) return fail(`ripgrep exited with code ${run.exitCode}.`);
  return undefined;
}

export function partialNote(run: RgRun, limits: RgLimits): string | undefined {
  if (run.timedOut)
    return `[Search stopped after ${limits.timeoutMs / 1000} s; results are partial. Narrow path, glob or type.]`;
  if (run.capped)
    return `[Output exceeded ${Math.round(limits.maxBytes / 1024 / 1024)} MB; ripgrep was stopped and results are partial. Narrow path, glob or type.]`;
  return undefined;
}

export function readNote(run: RgRun): string | undefined {
  const { unreadable } = stderrReport(run.stderr);
  return unreadable > 0 ? `(${unreadable} paths couldn't be read)` : undefined;
}

/** Files under `scope` that the sensitive-file exclusions hide, as paths relative to `cwd`. */
export async function listSensitive(
  ctx: ToolContext,
  rg: AbsPath,
  cwd: AbsPath,
  scope: readonly string[],
  noIgnore: boolean,
  limits: RgLimits,
): Promise<string[]> {
  const whitelist = sensitiveGlobs(ctx.settings).flatMap((g) => ["--glob", g]);
  const args = ["--no-config", "--hidden", "--no-require-git", ...(noIgnore ? ["--no-ignore"] : []), ...VCS_EXCLUDE];
  const run = await runRg(ctx, rg, [...args, "--files", ...whitelist, ...scope], cwd, limits);
  if (!isRun(run) || run.interrupted || run.exitCode === null || run.exitCode > 1) return [];
  return run.stdout.split("\n").filter((l) => l !== "");
}

/** Whether `target` or a folder above it (below `cwd`) is excluded by an ignore file. Uses ripgrep's own verdict. */
export async function isIgnoredPath(
  ctx: ToolContext,
  rg: AbsPath,
  cwd: AbsPath,
  target: AbsPath,
  limits: RgLimits,
): Promise<boolean> {
  const os = ctx.platform.os;
  let current: string = target;
  while (current !== cwd && isWithin(current, cwd, os)) {
    const parent = dirname(current);
    const name = basename(current).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const run = await runRg(
      ctx,
      rg,
      ["--no-config", "--debug", "--files", "--hidden", "--no-require-git", "--max-depth", "1"],
      parent as AbsPath,
      limits,
      limits.maxBytes,
    );
    if (isRun(run) && new RegExp(`ignoring (?:\\.[/\\\\])?${name}: Ignore\\(IgnoreMatch\\(Git`).test(run.stderr))
      return true;
    current = parent;
  }
  return false;
}

export function displayPath(path: string, cwd: string, os: "linux" | "darwin" | "win32"): string {
  if (!isWithin(path, cwd, os)) return path;
  const rel = (os === "win32" ? win32 : posix).relative(cwd, path);
  return rel === "" ? "." : rel;
}

/** ripgrep prints `./x` when the search root is `.`; the model sees `x`. */
export const withoutDot = (path: string): string => path.replace(/^\.[/\\]/, "");
