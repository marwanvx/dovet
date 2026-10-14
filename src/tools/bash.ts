// Bash (tools §5) and PowerShell (§6): a fresh process per command, the command written into a script file, cwd carried over.
import { access, constants, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isErrno, isWithin } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { collectOutput } from "./child-output.ts";
import { sha256Of, sniffEncoding } from "./codec.ts";
import { OUTPUT_LIMIT } from "./output.ts";
import { type Edition, isPolicyRefusal, powershellArgv, powershellScript } from "./powershell-script.ts";
import { MAX_SCAN_BYTES } from "./read-scan.ts";
import {
  exitOneIsBenign,
  fileView,
  interactiveNotice,
  rewriteNulRedirects,
  rewritesWorktree,
} from "./shell-command.ts";
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
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024;
const MAX_LISTED = 20;

async function raceAbort<T>(work: Promise<T> | undefined, signal: AbortSignal): Promise<T | undefined> {
  if (work === undefined) return undefined;
  let stop: () => void = () => {};
  const aborted = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export function createBashTool(opts: {
  /** `<data>/tmp`: script and cwd files live in `sh/` below it. */
  tmpDir: string;
  /** Where output beyond 30,000 characters is kept (the session directory); defaults to `out/` below `tmpDir`. */
  outputDir?: string;
  /** The command is stopped once its output passes this many bytes. */
  outputCapBytes?: number;
  snapshot?: ShellSnapshot | undefined;
  /** PowerShell instead of bash; `edition` picks the 5.1 wrapper and tool description. */
  powershell?: {
    edition: Edition /** Start in `-Command` mode, as after a Group Policy refusal. */;
    viaCommand?: boolean;
  };
}): ToolDefinition<BashInput> {
  let noteShown = false;
  let viaCommand = opts.powershell?.viaCommand ?? false;
  const ps = opts.powershell;
  const toolName = ps === undefined ? "Bash" : "PowerShell";

  async function findShell(ctx: ToolContext): Promise<{ path: AbsPath; warning?: string }> {
    const configured = ctx.settings.shell?.path;
    if (configured !== undefined) return { path: configured as AbsPath };
    if (ps !== undefined) {
      const found =
        ctx.platform.shells().powershell ??
        (await ctx.platform.resolve(ps.edition === "pwsh" ? "pwsh" : "powershell")) ??
        (await ctx.platform.resolve("pwsh"));
      if (found === undefined) throw new Error("PowerShell was not found: install PowerShell or set shell.path");
      return { path: found };
    }
    if (ctx.platform.os === "win32") {
      const choice = await ctx.platform.resolveShell(ctx.settings.shell);
      if (choice?.kind !== "git-bash")
        throw new Error("Git Bash was not found: install Git for Windows or set shell.path");
      return { path: choice.path };
    }
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

  async function recordView(ctx: ToolContext, view: { file: string; whole: boolean }): Promise<void> {
    const path = ctx.platform.canonicalize(view.file, ctx.session.cwd);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch (e) {
      if (isErrno(e, "ENOENT", "ENOTDIR", "EACCES")) return;
      throw e;
    }
    if (!info.isFile() || info.size > MAX_SCAN_BYTES) return;
    const bytes = new Uint8Array(await readFile(path));
    const encoding = sniffEncoding(bytes);
    const crlf = Buffer.from(bytes).toString("latin1").split("\r\n").length - 1;
    const lf = Buffer.from(bytes).toString("latin1").split("\n").length - 1 - crlf;
    ctx.readState.set(path, {
      sha256: sha256Of(bytes),
      mtimeMs: info.mtimeMs,
      size: info.size,
      partial: !view.whole || encoding === "invalid",
      encoding,
      eol: crlf > 0 && lf > 0 ? "mixed" : crlf > 0 ? "\r\n" : "\n",
    });
  }

  async function listChanges(
    ctx: ToolContext,
    before: string,
    command: string,
    fileChanges: NonNullable<ToolOutput["meta"]>["fileChanges"] & {},
  ): Promise<string | undefined> {
    const snapshots = ctx.snapshots;
    if (snapshots === undefined) return undefined;
    const changes = await snapshots.changes(before, (await snapshots.snapshot()).tree);
    if (changes.length === 0) return undefined;
    const namesOnly = rewritesWorktree(command);
    const shown = changes.slice(0, MAX_LISTED).map((c) => {
      const path = join(snapshots.root, c.path) as AbsPath;
      if (c.status !== "D") {
        fileChanges.push({ path, op: c.status === "A" ? "create" : "modify", added: c.added, removed: c.removed });
      }
      const marks: string[] = [];
      if (c.status === "D") marks.push("deleted");
      else if (!namesOnly) marks.push(`+${c.added} −${c.removed}`);
      if (!namesOnly && ctx.readState.get(path) !== undefined) marks.push("re-read before editing");
      return marks.length === 0 ? c.path : `${c.path} (${marks.join(", ")})`;
    });
    const more = changes.length > MAX_LISTED ? `, and ${changes.length - MAX_LISTED} more` : "";
    return `Files changed while this ran: ${shown.join(", ")}${more}`;
  }

  async function missingCwd(ctx: ToolContext): Promise<ToolOutput | undefined> {
    try {
      await stat(ctx.session.cwd);
      return undefined;
    } catch (e) {
      if (!isErrno(e, "ENOENT", "ENOTDIR")) throw e;
    }
    const root = ctx.session.workingDirs[0] ?? ctx.session.cwd;
    return {
      status: "error",
      content: [
        {
          kind: "text",
          text: `The working directory ${ctx.session.cwd} no longer exists (deleted or unmounted). The working directory is reset to ${root}; run the command again.`,
        },
      ],
      meta: { effects: root === ctx.session.cwd ? [] : [{ kind: "cwd", path: root }] },
    };
  }

  async function run(input: BashInput, ctx: ToolContext): Promise<ToolOutput> {
    const interactive = interactiveNotice(input.command);
    if (interactive !== undefined) return { status: "error", content: [{ kind: "text", text: interactive }] };
    const started = Date.now();
    const gone = await missingCwd(ctx);
    if (gone !== undefined) return gone;
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
    let command = input.command;
    if (ctx.platform.os === "win32" && ps === undefined) {
      const rewritten = rewriteNulRedirects(command);
      if (rewritten.changed) {
        command = rewritten.command;
        notes.push("A redirect to `nul` was rewritten to /dev/null (Git Bash would create a file named nul).");
      }
    }
    const runMarker = `DOVET_RUN=${crypto.randomUUID()}`;
    const { env: baseEnv } = commandEnv({
      os: ctx.platform.os,
      launch: ctx.env,
      snapshot: snapshot.env,
      envFile,
      settingsEnv: ctx.settings.env as Record<string, string> | undefined,
      passEnv: ctx.settings.shell?.passEnv,
    });
    const env = { ...baseEnv, DOVET_RUN: runMarker.slice("DOVET_RUN=".length) };
    const view = fileView(input.command);
    let before: string | undefined;
    if (view === undefined && ctx.snapshots !== undefined) {
      try {
        before = (await ctx.snapshots.snapshot()).tree;
      } catch (e) {
        notes.push(`Couldn't list the files this command changes: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const id = crypto.randomUUID().slice(0, 8);
    const dir = join(opts.tmpDir, ps === undefined ? "sh" : "ps");
    const outputDir = opts.outputDir ?? join(opts.tmpDir, "out");
    const script = join(dir, ps === undefined ? `${id}.sh` : `${id}.ps1`);
    const cwdFile = join(dir, `${id}.cwd`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const scriptText =
      ps === undefined
        ? `set +H\ntrap ${quote(`${ctx.platform.os === "win32" ? "pwd -W" : "pwd -P"} > ${quote(cwdFile)}`)} EXIT\ncd -- ${quote(ctx.session.cwd)} || exit 1\n${command}\n`
        : powershellScript({ command: input.command, cwd: ctx.session.cwd, cwdFile, edition: ps.edition });
    await writeFile(script, ps === undefined ? scriptText : `\uFEFF${scriptText}`, { mode: 0o600 });

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
    const group = `${toolName.toLowerCase()}:${ctx.session.id}:${id}`;
    try {
      if (abort.signal.aborted) {
        return {
          status: ctx.signal.aborted ? "interrupted" : "timeout",
          content: [
            {
              kind: "text",
              text: ctx.signal.aborted
                ? "Interrupted by the user"
                : `Command timed out after ${Math.round(timeoutMs / 1000)}s`,
            },
          ],
        };
      }
      const cap = opts.outputCapBytes ?? OUTPUT_CAP_BYTES;
      let capped = false;
      let stragglers: Array<{ name: string }> = [];
      const decoder = new TextDecoder();
      let out: Awaited<ReturnType<typeof collectOutput>>;
      for (;;) {
        const child = ctx.platform.spawn({
          argv:
            ps === undefined
              ? [shell.path, script]
              : powershellArgv({ exe: shell.path, scriptPath: script, scriptText, viaCommand }),
          cwd: ctx.session.cwd,
          env,
          stdin: "null",
          signal: abort.signal,
          group,
        });
        out = await collectOutput(child, {
          onChunk: (c) => ctx.emit({ kind: "tail", text: decoder.decode(c, { stream: true }) }),
          afterExit: async () => {
            try {
              stragglers = await ctx.platform.sweep(group, runMarker);
            } catch (e) {
              notes.push(
                `Couldn't look for processes the command left running: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          },
          maxBytes: cap,
          onLimit: () => {
            capped = true;
            abort.abort();
          },
        });
        if (ps === undefined || viaCommand || out.code === 0 || !isPolicyRefusal(out.merged.toString("utf8"))) break;
        // The wrapper's `finally` writes the cwd file once the script has started, so a refusal never has one.
        if (
          await access(cwdFile).then(
            () => true,
            () => false,
          )
        )
          break;
        viaCommand = true;
        notes.push("Group Policy enforces a PowerShell execution policy; commands run with -Command from now on.");
      }
      let text = sanitizeOutput(out.merged);
      if (capped) text += `\nOutput exceeded ${Math.round(cap / 1_000_000)} MB; the command was stopped.`;
      if (stragglers.length > 0) {
        const names = [...new Set(stragglers.map((p) => p.name))].slice(0, 3);
        notes.push(
          `Stopped ${stragglers.length} background process(es) the command left running (e.g. ${names.map((n) => `"${n}"`).join(", ")}). Long-running servers aren't supported in v0.1; start them yourself in a terminal.`,
        );
      }
      const effects = await carryOver(ctx, cwdFile, notes);
      const fileChanges: NonNullable<NonNullable<ToolOutput["meta"]>["fileChanges"]> = [];
      if (before !== undefined) {
        try {
          const listing = await listChanges(ctx, before, input.command, fileChanges);
          if (listing !== undefined) notes.push(listing);
        } catch (e) {
          notes.push(`Couldn't list the changed files: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const meta = {
        exitCode: out.code ?? -1,
        durationMs: Date.now() - started,
        effects,
        ...(fileChanges.length > 0 ? { fileChanges } : {}),
      };
      const body = (head: string): ToolOutput["content"] => [
        { kind: "text", text: [head, ...notes].filter((s) => s !== "").join("\n") },
      ];
      if (timedOut)
        return {
          status: "timeout",
          content: body(
            `Command timed out after ${Math.round(timeoutMs / 1000)}s\n${headAndTail(text, FAILURE_EXCERPT)}`,
          ),
          meta,
        };
      if (ctx.signal.aborted)
        return {
          status: "interrupted",
          content: body(`Interrupted by the user\n${headAndTail(text, FAILURE_EXCERPT)}`),
          meta,
        };
      const benign = out.code === 1 && exitOneIsBenign(input.command);
      if (out.code !== 0 && !benign) {
        return {
          status: "error",
          content: body(
            `${out.code === null ? "Killed by a signal" : `Exit code ${out.code}`}\n${headAndTail(text, FAILURE_EXCERPT)}`,
          ),
          meta,
        };
      }
      if (view !== undefined && text !== "") await recordView(ctx, view);
      let shown = text === "" ? "(no output)" : text;
      let offloadPath: AbsPath | undefined;
      try {
        if (shown.length > OUTPUT_LIMIT) {
          const path = join(outputDir, `${id}.txt`);
          await mkdir(outputDir, { recursive: true, mode: 0o700 });
          await writeFile(path, shown, { mode: 0o600 });
          offloadPath = path as AbsPath;
          const last = shown.charCodeAt(1_999);
          shown = `${shown.slice(0, last >= 0xd800 && last <= 0xdbff ? 1_999 : 2_000)}\n[Output too long (${shown.length} chars). Full output saved to ${path}. Read it with offset/limit or search it.]`;
        }
      } catch (e) {
        if (!isErrno(e, "ENOSPC", "EDQUOT")) throw e;
        await rm(join(outputDir, `${id}.txt`), { force: true });
        shown = `Disk full: output was cut at ${Buffer.byteLength(shown)} bytes`;
      }
      return { status: "ok", content: body(shown), meta: offloadPath ? { ...meta, offloadPath } : meta };
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
      final = (await readFile(cwdFile, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
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
    name: toolName,
    input: BashInput,
    descriptionFile:
      ps === undefined ? "tools/Bash.md" : ps.edition === "pwsh" ? "tools/PowerShell.md" : "tools/PowerShell51.md",
    errorExample: { command: "ls -la", description: "List files in the current directory", timeout: 120_000 },
    parallelSafe: false,
    mutates: "system",
    describeAction(input) {
      return {
        kind: "shell",
        shell: ps === undefined ? "bash" : "powershell",
        command: input.command,
        sandboxed: false,
        unsandboxedRetry: input.dangerouslyDisableSandbox === true,
        effects: { writes: "unknown", network: "unknown", sensitiveReads: [], remote: [], sandboxed: false },
      };
    },
    run,
  };
}
