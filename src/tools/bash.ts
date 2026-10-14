// Bash (tools §5): a fresh process per command, the command written verbatim into a script file, cwd carried over.
import { access, constants, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isErrno, isWithin } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { collectOutput } from "./child-output.ts";
import { commandEnv, parseEnvFile, type ShellSnapshot } from "./shell-env.ts";
import { headAndTail, sanitizeOutput } from "./shell-output.ts";
import type { SessionEffect, ToolContext, ToolDefinition, ToolOutput } from "./types.ts";

const BashInput = z.strictObject({
  command: z.string().min(1),
  timeout: z.number().int().min(1).optional(),
  description: z.string().optional(),
  dangerouslyDisableSandbox: z.boolean().optional(),
});
type BashInput = z.infer<typeof BashInput>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const FAILURE_EXCERPT = 10_000;

async function raceAbort<T>(work: Promise<T> | undefined, signal: AbortSignal): Promise<T | undefined> {
  if (work === undefined) return undefined;
  const aborted = new Promise<undefined>((resolve) =>
    signal.addEventListener("abort", () => resolve(undefined), { once: true }),
  );
  return Promise.race([work, aborted]);
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export function createBashTool(opts: {
  /** `<data>/tmp`: script and cwd files live in `sh/` below it. */
  tmpDir: string;
  snapshot?: ShellSnapshot | undefined;
}): ToolDefinition<BashInput> {
  let noteShown = false;

  async function findShell(ctx: ToolContext): Promise<{ path: AbsPath; warning?: string }> {
    const configured = ctx.settings.shell?.path;
    if (configured !== undefined) return { path: configured as AbsPath };
    const found = ctx.platform.shells().bash ?? (await ctx.platform.resolve("bash"));
    if (found !== undefined) return { path: found };
    for (const candidate of ["/bin/bash", "/bin/sh"] as const) {
      try {
        await access(candidate, constants.X_OK);
        return candidate === "/bin/bash"
          ? { path: candidate as AbsPath }
          : { path: candidate as AbsPath, warning: "bash was not found; running with /bin/sh." };
      } catch (e) {
        if (!isErrno(e, "ENOENT", "EACCES")) throw e;
      }
    }
    throw new Error("No shell found: install bash or set shell.path");
  }

  async function readEnvFile(ctx: ToolContext): Promise<Record<string, string>> {
    const file = ctx.settings.shell?.envFile;
    if (file === undefined) return {};
    return parseEnvFile(await readFile(ctx.platform.canonicalize(file, ctx.session.cwd), "utf8"));
  }

  async function run(input: BashInput, ctx: ToolContext): Promise<ToolOutput> {
    const started = Date.now();
    const shell = await findShell(ctx);
    const snapshot = (await raceAbort(opts.snapshot?.ready(), ctx.signal)) ?? { env: null };
    if (ctx.signal.aborted)
      return { status: "interrupted", content: [{ kind: "text", text: "Interrupted by the user" }] };
    const notes: string[] = [];
    if (shell.warning) notes.push(shell.warning);
    if (snapshot.note !== undefined && !noteShown) {
      noteShown = true;
      notes.push(snapshot.note);
    }
    let envFile: Record<string, string>;
    try {
      envFile = await readEnvFile(ctx);
    } catch (e) {
      if (!isErrno(e, "ENOENT", "EACCES", "EISDIR")) throw e;
      return {
        status: "error",
        content: [
          {
            kind: "text",
            text: `shell.envFile (${ctx.settings.shell?.envFile}) can't be read: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
      };
    }
    const { env } = commandEnv({
      os: ctx.platform.os,
      launch: ctx.env,
      snapshot: snapshot.env,
      envFile,
      settingsEnv: ctx.settings.env as Record<string, string> | undefined,
      passEnv: ctx.settings.shell?.passEnv,
    });

    const id = crypto.randomUUID().slice(0, 8);
    const dir = join(opts.tmpDir, "sh");
    const script = join(dir, `${id}.sh`);
    const cwdFile = join(dir, `${id}.cwd`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      script,
      `set +H\ntrap ${quote(`${ctx.platform.os === "win32" ? "pwd -W" : "pwd -P"} > ${quote(cwdFile)}`)} EXIT\ncd -- ${quote(ctx.session.cwd)} || exit 1\n${input.command}\n`,
      { mode: 0o600 },
    );

    const timeoutMs = Math.min(
      input.timeout ?? ctx.settings.shell?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      ctx.settings.shell?.maxTimeoutMs ?? MAX_TIMEOUT_MS,
    );
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    const onAbort = (): void => abort.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const group = `bash:${ctx.session.id}:${id}`;
    try {
      const child = ctx.platform.spawn({
        argv: [shell.path, script],
        cwd: ctx.session.cwd,
        env,
        stdin: "null",
        signal: abort.signal,
        group,
      });
      const out = await collectOutput(child, (c) => ctx.emit({ kind: "tail", text: new TextDecoder().decode(c) }));
      const text = sanitizeOutput(out.merged);
      const effects = await carryOver(ctx, cwdFile, notes);
      const meta = { exitCode: out.code ?? -1, durationMs: Date.now() - started, effects };
      const body = (head: string): ToolOutput["content"] => [
        { kind: "text", text: [head, ...notes].filter((s) => s !== "").join("\n") },
      ];
      if (timedOut)
        return {
          status: "timeout",
          content: body(`Command timed out after ${Math.round(timeoutMs / 1000)}s\n${text}`),
          meta,
        };
      if (ctx.signal.aborted) return { status: "interrupted", content: body(`Interrupted by the user\n${text}`), meta };
      if (out.code !== 0) {
        return {
          status: "error",
          content: body(
            `${out.code === null ? "Killed by a signal" : `Exit code ${out.code}`}\n${headAndTail(text, FAILURE_EXCERPT)}`,
          ),
          meta,
        };
      }
      return { status: "ok", content: body(text === "" ? "(no output)" : text), meta };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      await ctx.platform.killTree(group);
      await Promise.all([rm(script, { force: true }), rm(cwdFile, { force: true })]);
    }
  }

  async function carryOver(ctx: ToolContext, cwdFile: string, notes: string[]): Promise<SessionEffect[]> {
    const root = ctx.session.workingDirs[0] ?? ctx.session.cwd;
    if (ctx.settings.shell?.resetCwd === true) {
      return ctx.session.cwd === root ? [] : [{ kind: "cwd", path: root }];
    }
    let final: string;
    try {
      final = (await readFile(cwdFile, "utf8")).replace(/\r?\n$/, "");
      if (ctx.platform.os === "win32") final = final.replaceAll("/", "\\");
    } catch (e) {
      if (isErrno(e, "ENOENT")) return [];
      throw e;
    }
    if (final === "" || final === ctx.session.cwd) return [];
    const os = ctx.platform.os;
    if (ctx.session.workingDirs.some((d) => isWithin(final, d, os))) return [{ kind: "cwd", path: final as AbsPath }];
    notes.push(`Shell cwd was reset to ${ctx.session.cwd}`);
    return [];
  }

  return {
    name: "Bash",
    input: BashInput,
    descriptionFile: "tools/Bash.md",
    errorExample: { command: "ls -la", description: "List files in the current directory", timeout: 120_000 },
    parallelSafe: false,
    mutates: "system",
    describeAction(input) {
      return {
        kind: "shell",
        shell: "bash",
        command: input.command,
        sandboxed: false,
        unsandboxedRetry: input.dangerouslyDisableSandbox === true,
        effects: { writes: "unknown", network: "unknown", sensitiveReads: [], remote: [], sandboxed: false },
      };
    },
    run,
  };
}
