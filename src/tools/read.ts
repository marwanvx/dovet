// Read, text files (tools §1); images and PDFs come with M2.

import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { isErrno, lexicalPath, PathRefused } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { fileEffects } from "./policy.ts";
import { DEDUP_PREFIX, sha256Hex } from "./read-results.ts";
import { formatLine, type ScanOptions, type ShownLine, scanText } from "./read-scan.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.ts";

const ReadInput = z.strictObject({
  file_path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  pages: z.string().optional(),
  allow_large: z.boolean().optional(),
});
type ReadInput = z.infer<typeof ReadInput>;

const BINARY_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};
const CHARS_PER_TOKEN = 3.5;
const DEFAULT_MAX_TOKENS = 25_000;

const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });

function kindOf(st: {
  isFIFO(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
}): string {
  if (st.isFIFO()) return "FIFO";
  if (st.isSocket()) return "socket";
  if (st.isCharacterDevice()) return "character device";
  return st.isBlockDevice() ? "block device" : "special file";
}

function firstPage(lines: readonly ShownLine[], budgetChars: number): ShownLine[] {
  const page: ShownLine[] = [];
  let used = 0;
  for (const line of lines) {
    const size = formatLine(line).length + 1;
    if (page.length > 0 && used + size > budgetChars) break;
    page.push(line);
    used += size;
  }
  return page;
}

export function createReadTool(opts: { afterCheck?: () => Promise<void> } = {}): ToolDefinition<ReadInput> {
  async function run(input: ReadInput, ctx: ToolContext): Promise<ToolOutput> {
    if (input.pages?.includes(",")) return fail("Read one page or range per call.");
    const byName = BINARY_BY_EXTENSION[extname(input.file_path).toLowerCase()];
    let path: AbsPath;
    try {
      path = ctx.platform.canonicalize(input.file_path, ctx.session.cwd);
    } catch (e) {
      if (e instanceof PathRefused) return fail(e.message);
      throw e;
    }
    let checked: BigIntStats;
    try {
      checked = await stat(path, { bigint: true });
    } catch (e) {
      if (isErrno(e, "ENOENT", "ENOTDIR")) return fail(`File not found: ${path}`);
      if (isErrno(e, "EACCES", "EPERM")) return fail(`Permission denied: ${path}`);
      throw e;
    }
    if (checked.isDirectory()) return fail(`${path} is a directory. List it with Glob or ls.`);
    if (!checked.isFile())
      return fail(`${path} is not a regular file (${kindOf(checked)}); reading it could block or never end.`);
    if (byName !== undefined) return fail(`Binary file (${checked.size} bytes, ${byName}). Not readable as text.`);
    await opts.afterCheck?.();

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    } catch (e) {
      if (isErrno(e, "ENOENT", "ENOTDIR", "ELOOP", "ENXIO"))
        return fail(`${path} changed while it was being opened. Try again.`);
      if (isErrno(e, "EACCES", "EPERM")) return fail(`Permission denied: ${path}`);
      throw e;
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== checked.dev || opened.ino !== checked.ino || !opened.isFile())
        return fail(`${path} changed while it was being opened. Try again.`);

      const maxTokens = ctx.settings.read?.maxTokens ?? DEFAULT_MAX_TOKENS;
      const pageChars = maxTokens * CHARS_PER_TOKEN;
      const whole = input.offset === undefined && input.limit === undefined;
      const freeChars = (ctx.contextFreeTokens / 2) * CHARS_PER_TOKEN;
      const scanOpts: ScanOptions = {
        start: input.offset ?? 1,
        maxLines: input.limit ?? Number.POSITIVE_INFINITY,
        budgetChars: whole && input.allow_large ? Math.max(pageChars, freeChars) : pageChars,
      };
      const scan = await scanText(handle, scanOpts);
      if (scan.binary) return fail(`Binary file (${opened.size} bytes, ${scan.detected}). Not readable as text.`);

      const label = scan.capped ? `${scan.total}+` : String(scan.total);
      let shown = scan.shown;
      let notice = "";
      let partial: boolean;
      if (scan.total === 0) {
        notice = "[File exists but is empty.]";
        partial = false;
      } else if (scanOpts.start > scan.total) {
        notice = `[File has ${label} lines; offset ${scanOpts.start} is past the end.]`;
        shown = [];
        partial = false;
      } else if (whole) {
        const complete = shown.length === scan.total && !scan.capped;
        if (complete && (scan.totalChars <= pageChars || input.allow_large)) {
          partial = false;
        } else {
          shown = firstPage(shown, pageChars);
          const tokens = Math.ceil(scan.totalChars / CHARS_PER_TOKEN);
          const last = shown[shown.length - 1]?.n ?? 1;
          const tooLarge = input.allow_large
            ? `Too large even with allow_large (~${tokens} tokens; ~${ctx.contextFreeTokens} free). Read more with offset/limit or search with Grep.`
            : "Read more with offset/limit, search with Grep, or pass allow_large: true if you need the whole file.";
          notice = `[PARTIAL view: lines 1–${last} of ${label} (~${tokens} tokens total). ${tooLarge}]`;
          partial = true;
        }
      } else {
        const last = shown[shown.length - 1]?.n ?? scanOpts.start;
        if (scan.budgetHit)
          notice = `[PARTIAL view: lines ${scanOpts.start}–${last} of ${label}. Continue with offset=${last + 1}.]`;
        partial = scanOpts.start > 1 || last < scan.total || scan.capped;
      }

      const hidden = shown.reduce((sum, l) => sum + l.hidden, 0);
      const body = shown.map(formatLine).join("\n");
      const parts = [body, notice];
      if (hidden > 0)
        parts.push(`[${hidden} hidden characters were removed from this view; the file on disk still contains them.]`);
      const result = parts.filter((p) => p !== "").join("\n");

      ctx.readState.set(path, {
        sha256: scan.sha256,
        mtimeMs: Number(opened.mtimeMs),
        size: Number(opened.size),
        partial,
        encoding: scan.encoding,
        eol: scan.eol,
      });

      const earlier = ctx.readResults.lookup({
        file_path: input.file_path,
        offset: input.offset,
        limit: input.limit,
        pages: input.pages,
      });
      if (earlier && !earlier.dedup && earlier.sha256 === sha256Hex(result)) {
        const text = `${DEDUP_PREFIX}${earlier.turn} (same range); its content is in that earlier result.`;
        return { status: "ok", content: [{ kind: "text", text }] };
      }
      return {
        status: "ok",
        content: [{ kind: "text", text: result }],
        ...(hidden > 0 ? { meta: { effects: [{ kind: "taint" as const, source: `Read: ${path}` }] } } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  return {
    name: "Read",
    input: ReadInput,
    descriptionFile: "tools/Read.md",
    errorExample: { file_path: "src/index.ts", offset: 1, limit: 100 },
    parallelSafe: true,
    mutates: "none",
    normalize: { aliases: { path: "file_path", filePath: "file_path" } },
    pathFields: ["file_path"],
    limitsOwnOutput: true,
    describeAction(input, ctx) {
      let paths: AbsPath[] = [];
      try {
        const canonical = ctx.platform.canonicalize(input.file_path, ctx.session.cwd);
        const requested = lexicalPath(input.file_path, ctx.session.cwd, ctx.platform.os);
        paths = requested === canonical ? [canonical] : [requested as AbsPath, canonical];
      } catch (e) {
        // run() refuses the same path, so nothing is read when the policy sees no path.
        if (!(e instanceof PathRefused)) throw e;
      }
      return { kind: "read", paths, effects: fileEffects(ctx, "read", paths) };
    },
    run,
  };
}

export const readTool = createReadTool();
