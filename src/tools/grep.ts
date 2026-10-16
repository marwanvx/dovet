// Grep (tools §7): ripgrep with ignore files honored outside git, sensitive files skipped, hard time and output limits.
import { access, constants, stat } from "node:fs/promises";
import { z } from "zod";
import { isErrno, lexicalPath, PathRefused } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { stripHidden } from "./hidden.ts";
import { fileEffects } from "./policy.ts";
import {
  baseArgs,
  DEFAULT_LIMITS,
  displayPath,
  fail,
  isBinary,
  isIgnoredPath,
  isRun,
  listSensitive,
  locateRg,
  partialNote,
  type RgLimits,
  type RgRun,
  readNote,
  runFailure,
  runRg,
  withoutDot,
} from "./rg.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.ts";

const Context = z.number().int().min(0);
const GrepInput = z.strictObject({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  output_mode: z.enum(["files_with_matches", "content", "count"]).default("files_with_matches"),
  "-i": z.boolean().optional(),
  "-n": z.boolean().default(true),
  "-A": Context.optional(),
  "-B": Context.optional(),
  "-C": Context.optional(),
  multiline: z.boolean().optional(),
  head_limit: z.number().int().min(1).default(250),
  offset: z.number().int().min(0).default(0),
});
type GrepInput = z.infer<typeof GrepInput>;

const MAX_LINE = 500;
const JsonLine = z.object({
  type: z.string(),
  data: z.looseObject({
    path: z.object({ text: z.string().optional(), bytes: z.string().optional() }).optional(),
    lines: z.object({ text: z.string().optional(), bytes: z.string().optional() }).optional(),
    line_number: z.number().nullable().optional(),
  }),
});

type Entry = { path: string; n: number; sep: ":" | "-"; text: string };

const decodeField = (f: { text?: string | undefined; bytes?: string | undefined } | undefined): string =>
  f?.text ?? Buffer.from(f?.bytes ?? "", "base64").toString("utf8");

function parseJson(stdout: string, tolerateTail: boolean): Entry[] {
  const lines = stdout.split("\n");
  const entries: Entry[] = [];
  lines.forEach((raw, i) => {
    if (raw === "") return;
    let parsed: z.infer<typeof JsonLine>;
    try {
      parsed = JsonLine.parse(JSON.parse(raw));
    } catch (e) {
      if (tolerateTail && i >= lines.length - 2) return;
      throw new Error(`Unreadable ripgrep output: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (parsed.type !== "match" && parsed.type !== "context") return;
    const path = withoutDot(decodeField(parsed.data.path));
    const text = decodeField(parsed.data.lines).replace(/\r?\n$/, "");
    const first = parsed.data.line_number ?? 0;
    const sep = parsed.type === "match" ? ":" : "-";
    for (const [k, line] of text.split("\n").entries())
      entries.push({ path, n: first + k, sep, text: line.replace(/\r$/, "") });
  });
  return entries;
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortEntries(entries: Entry[]): Entry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => byPath(a.e.path, b.e.path) || a.i - b.i)
    .map((x) => x.e);
}

function renderContent(page: Entry[], input: GrepInput, hidden: { n: number }): string {
  const withContext = input["-A"] !== undefined || input["-B"] !== undefined || input["-C"] !== undefined;
  const out: string[] = [];
  let file: string | undefined;
  let last = 0;
  for (const e of page) {
    if (e.path !== file) {
      if (file !== undefined) out.push("");
      out.push(e.path);
      file = e.path;
    } else if (withContext && e.n !== last + 1) {
      out.push("--");
    }
    last = e.n;
    const clean = stripHidden(e.text);
    hidden.n += clean.removed;
    const shown = clean.text.length > MAX_LINE ? `${clean.text.slice(0, MAX_LINE)} […line truncated]` : clean.text;
    out.push(input["-n"] ? `${e.n}${e.sep}${shown}` : shown);
  }
  return out.join("\n");
}

function parseNames(stdout: string): string[] {
  return stdout
    .split("\0")
    .filter((p) => p !== "" && p !== "\n")
    .map(withoutDot);
}

export function createGrepTool(opts: { limits?: Partial<RgLimits> } = {}): ToolDefinition<GrepInput> {
  const limits: RgLimits = { ...DEFAULT_LIMITS, ...opts.limits };

  async function run(input: GrepInput, ctx: ToolContext): Promise<ToolOutput> {
    const cwd = ctx.session.cwd;
    const os = ctx.platform.os;
    const found = await locateRg(ctx);
    if (!isBinary(found)) return found;

    let target: AbsPath;
    try {
      target = ctx.platform.canonicalize(input.path ?? cwd, cwd);
    } catch (e) {
      if (e instanceof PathRefused) return fail(e.message);
      if (isErrno(e, "EACCES", "EPERM")) return fail(`Permission denied: ${input.path ?? cwd}`);
      throw e;
    }
    let isFile: boolean;
    try {
      const st = await stat(target);
      isFile = st.isFile();
      await access(target, st.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK);
    } catch (e) {
      if (isErrno(e, "ENOENT", "ENOTDIR")) return fail(`Path not found: ${target}`);
      if (isErrno(e, "EACCES", "EPERM")) return fail(`Permission denied: ${target}`);
      throw e;
    }

    const ignoredDir = !isFile && (await isIgnoredPath(ctx, found.path, cwd, target, limits));
    const scope = displayPath(target, cwd, os);
    const args = [...baseArgs(ctx, ignoredDir), "--max-columns", String(MAX_LINE), "--max-columns-preview"];
    if (input["-i"]) args.push("-i");
    if (input.multiline) args.push("-U", "--multiline-dotall");
    if (input.glob) args.push("--glob", input.glob);
    if (input.type) args.push("--type", input.type);
    if (input.output_mode === "content") {
      args.push("--json");
      for (const flag of ["-A", "-B", "-C"] as const) {
        const value = input[flag];
        if (value !== undefined) args.push(flag, String(value));
      }
    } else {
      args.push(input.output_mode === "count" ? "--count" : "--files-with-matches", "--null", "--with-filename");
    }
    args.push("-e", input.pattern, "--", scope);

    const [result, sensitive] = await Promise.all([
      runRg(ctx, found.path, args, cwd, limits),
      isFile
        ? Promise.resolve([])
        : listSensitive(
            ctx,
            found.path,
            cwd,
            [...(input.type ? ["--type", input.type] : []), "--", scope],
            ignoredDir,
            limits,
          ),
    ]);
    if (!isRun(result)) return result;
    const failed = runFailure(result);
    if (failed) return failed;

    const partial = result.timedOut || result.capped;
    const notes = [
      ignoredDir ? "Searched an ignored directory." : undefined,
      found.note,
      readNote(result),
      sensitive.length > 0 ? `(${sensitive.length} sensitive files skipped)` : undefined,
      partialNote(result, limits),
    ].filter((n): n is string => n !== undefined);
    return render(input, result, partial, notes);
  }

  function render(input: GrepInput, result: RgRun, partial: boolean, notes: string[]): ToolOutput {
    const hidden = { n: 0 };
    const reply = (body: string, extra: string[] = []): ToolOutput => {
      const all = hidden.n > 0 ? [...notes, `[${hidden.n} hidden characters were removed from these results.]`] : notes;
      const text = [body, ...extra, ...all].filter((p) => p !== "").join("\n");
      return {
        status: "ok",
        content: [{ kind: "text", text }],
        ...(hidden.n > 0 ? { meta: { effects: [{ kind: "taint" as const, source: "Grep results" }] } } : {}),
      };
    };
    let items: string[];
    let total: number;
    let footer: string[] = [];
    if (input.output_mode === "content") {
      const entries = sortEntries(parseJson(result.stdout, partial));
      total = entries.length;
      const page = entries.slice(input.offset, input.offset + input.head_limit);
      items = page.length > 0 ? [renderContent(page, input, hidden)] : [];
    } else if (input.output_mode === "files_with_matches") {
      const files = parseNames(result.stdout).sort(byPath);
      total = files.length;
      items = files.slice(input.offset, input.offset + input.head_limit);
    } else {
      const counts = result.stdout
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => {
          const at = l.lastIndexOf("\0");
          return { path: withoutDot(l.slice(0, at)), n: Number(l.slice(at + 1)) };
        })
        .sort((a, b) => byPath(a.path, b.path));
      total = counts.length;
      items = counts.slice(input.offset, input.offset + input.head_limit).map((c) => `${c.path}:${c.n}`);
      const matches = counts.reduce((sum, c) => sum + c.n, 0);
      footer = total > 0 ? [`Total: ${matches} matches in ${total} files.`] : [];
    }
    if (total === 0 && input.offset === 0)
      return reply(partial ? "Nothing found before the search stopped." : "No matches found.");
    if (input.offset >= total) return reply(`No entries at this offset (total ${total}).`);
    const end = Math.min(total, input.offset + input.head_limit);
    const more =
      end < total ? [`[Showing entries ${input.offset + 1}–${end} of ${total}. Use offset=${end} for more.]`] : [];
    const body = input.output_mode === "content" ? (items[0] ?? "") : items.join("\n");
    return reply(body, [...footer, ...more]);
  }

  return {
    name: "Grep",
    input: GrepInput,
    descriptionFile: "tools/Grep.md",
    errorExample: { pattern: "TODO", path: "src", output_mode: "content", "-n": true, head_limit: 250, offset: 0 },
    parallelSafe: true,
    mutates: "none",
    normalize: {
      aliases: { file_path: "path" },
      drop: ["-r"],
      rewrite(raw) {
        const input = { ...raw };
        if (input["-l"] === true && input.output_mode === undefined) input.output_mode = "files_with_matches";
        if (input["-c"] === true && input.output_mode === undefined) input.output_mode = "count";
        delete input["-l"];
        delete input["-c"];
        return input;
      },
    },
    pathFields: ["pattern", "path", "glob", "type"],
    describeAction(input, ctx) {
      let paths: AbsPath[] = [];
      try {
        const given = input.path ?? ctx.session.cwd;
        const canonical = ctx.platform.canonicalize(given, ctx.session.cwd);
        const requested = lexicalPath(given, ctx.session.cwd, ctx.platform.os);
        paths = requested === canonical ? [canonical] : [requested as AbsPath, canonical];
      } catch (e) {
        if (!(e instanceof PathRefused)) throw e;
      }
      return { kind: "read", paths, effects: fileEffects(ctx, "read", paths) };
    },
    run,
  };
}

export const grepTool = createGrepTool();
