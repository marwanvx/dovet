// Edit (tools §3): exact-match replacement with a short matching cascade.
import { access, constants, lstat, readFile, readlink, stat } from "node:fs/promises";
import { z } from "zod";
import { isErrno, lexicalPath, PathRefused } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { lineDelta, placeholderViolation } from "./change-guard.ts";
import { decode, dominantEol, encode, sha256Of, sniffEncoding } from "./codec.ts";
import { applyEdit, applyExact, closestMatch } from "./edit-match.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.ts";
import { type WriteHooks, writeBytes } from "./write-file.ts";

const EditInput = z.strictObject({
  file_path: z.string().min(1),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
type EditInput = z.infer<typeof EditInput>;

const MAX_BYTES = 50 * 1024 * 1024;
const CONTEXT_LINES = 3;
const STALE_NOTE =
  "Note: the file had other changes since you last read it. Re-read before edits that depend on surrounding code.";
const MATCH_NOTES = {
  exact: undefined,
  "prefix-strip": "Matched after removing the line-number prefixes.",
  indent: "Matched ignoring indentation differences.",
} as const;

const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });

export function createEditTool(opts: { hooks?: WriteHooks | undefined } = {}): ToolDefinition<EditInput> {
  async function run(input: EditInput, ctx: ToolContext): Promise<ToolOutput> {
    if (input.old_string === input.new_string)
      return fail("old_string and new_string are the same; nothing to change.");
    if (input.old_string === "") return fail("old_string is empty. Use Write to create a file.");
    let path: AbsPath;
    let requested: string;
    try {
      path = ctx.platform.canonicalize(input.file_path, ctx.session.cwd);
      requested = lexicalPath(input.file_path, ctx.session.cwd, ctx.platform.os);
    } catch (e) {
      if (e instanceof PathRefused) return fail(e.message);
      throw e;
    }
    const link = await lstat(requested).catch((e: unknown) => {
      if (isErrno(e, "ENOENT", "ENOTDIR")) return undefined;
      throw e;
    });
    if (link?.isSymbolicLink())
      return fail(`${requested} is a symlink to ${await readlink(requested)}. Edit the target path instead.`);
    const st = await stat(path).catch((e: unknown) => {
      if (isErrno(e, "ENOENT", "ENOTDIR")) return undefined;
      throw e;
    });
    if (st === undefined) return fail("File not found. Use Write to create it.");
    if (st.isDirectory()) return fail(`${path} is a directory.`);
    if (!st.isFile()) return fail(`${path} is not a regular file.`);
    if (st.size > MAX_BYTES)
      return fail(`${path} is ${Math.round(st.size / 1048576)} MB; edit it with a shell command (e.g. sed) instead.`);

    const before = await readFile(path);
    const encoding = sniffEncoding(before);
    if (encoding === "invalid") {
      const guess = before.some((b) => b >= 0x80 && b <= 0x9f) ? "Windows-1252" : "Latin-1";
      return fail(
        `${path} isn't valid UTF-8 (looks like ${guess}). Edit it with a shell command that preserves the encoding, or ask the user about converting it.`,
      );
    }
    const known = ctx.readState.get(path);
    if (known === undefined || known.partial) return fail(`You must Read ${path} in full before editing it.`);
    try {
      await access(path, constants.W_OK);
    } catch (e) {
      if (!isErrno(e, "EACCES", "EPERM", "EROFS")) throw e;
      return fail(
        `${path} is read-only. Version control tools such as Perforce keep files read-only until checked out; ask the user.`,
      );
    }

    const raw = decode(before, encoding);
    const eol = dominantEol(raw, known.eol);
    const mixed = raw.includes("\r\n") && /(^|[^\r])\n/.test(raw);
    const text = raw.replace(/\r\n/g, "\n");
    const oldText = input.old_string.replace(/\r\n/g, "\n");
    const newText = input.new_string.replace(/\r\n/g, "\n");
    const stale = sha256Of(before) !== known.sha256;
    const outcome = stale
      ? applyExact(text, oldText, newText, false, "exact")
      : applyEdit(text, oldText, newText, input.replace_all === true);
    if (outcome.kind === "many")
      return fail(
        stale
          ? "old_string not found in the current file (it changed since you read it). Read it again."
          : `old_string matches ${outcome.lines.length} places (lines ${outcome.lines.join(", ")}). Include more surrounding context, or set replace_all: true.`,
      );
    if (outcome.kind === "none") {
      if (stale) return fail("old_string not found in the current file (it changed since you read it). Read it again.");
      const near = closestMatch(text, oldText);
      if (near === undefined) return fail(`old_string not found in ${path}.`);
      return fail(
        `old_string not found in ${path}. Closest match (lines ${near.first}–${near.last}, ${near.percent}% similar):\n${near.diff}`,
      );
    }
    const violation = placeholderViolation(oldText, newText);
    if (violation !== undefined) return fail(violation);

    const body = eol === "\r\n" ? outcome.text.replace(/\n/g, "\r\n") : outcome.text;
    const bytes = encode(body, encoding);
    await ctx.recordWrite(path, before);
    const res = await writeBytes(path, bytes, { os: ctx.platform.os, hooks: opts.hooks });
    if (!res.ok) return fail(res.message);

    const after = await stat(path);
    ctx.readState.set(path, {
      sha256: sha256Of(bytes),
      mtimeMs: after.mtimeMs,
      size: after.size,
      partial: false,
      encoding,
      eol,
    });
    const { added, removed } = lineDelta(text, outcome.text);
    const lines = outcome.text.replace(/\n$/, "").split("\n");
    const first = Math.max(1, outcome.line - CONTEXT_LINES);
    const last = Math.min(lines.length, outcome.line + Math.max(outcome.span, 1) - 1 + CONTEXT_LINES);
    const region = lines.slice(first - 1, last).map((l, i) => `${first + i}\t${l}`);
    const header =
      input.replace_all === true && outcome.count > 1
        ? `Replaced ${outcome.count} occurrences in ${path} (+${added} −${removed} lines)`
        : `Edited ${path} (+${added} −${removed} lines)`;
    const notes = [
      MATCH_NOTES[outcome.level],
      stale ? STALE_NOTE : undefined,
      mixed
        ? `The file had mixed line endings; every line now ends with ${eol === "\r\n" ? "CRLF" : "LF"}.`
        : undefined,
      ...res.notes,
    ].filter((n) => n !== undefined);
    return {
      status: "ok",
      content: [{ kind: "text", text: [header, ...notes, ...region].join("\n") }],
      meta: { fileChanges: [{ path, op: "modify", added, removed, match: outcome.level }] },
    };
  }

  return {
    name: "Edit",
    input: EditInput,
    descriptionFile: "tools/Edit.md",
    errorExample: { file_path: "src/index.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
    parallelSafe: false,
    mutates: "files",
    normalize: {
      aliases: {
        path: "file_path",
        filePath: "file_path",
        old_str: "old_string",
        new_str: "new_string",
      },
    },
    pathFields: ["file_path"],
    describeAction(input, ctx) {
      let paths: AbsPath[] = [];
      try {
        const canonical = ctx.platform.canonicalize(input.file_path, ctx.session.cwd);
        const lexical = lexicalPath(input.file_path, ctx.session.cwd, ctx.platform.os);
        paths = lexical === canonical ? [canonical] : [lexical as AbsPath, canonical];
      } catch (e) {
        if (!(e instanceof PathRefused)) throw e;
      }
      return {
        kind: "edit",
        paths,
        effects: { writes: "unknown", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
      };
    },
    run,
  };
}

export const editTool = createEditTool();
