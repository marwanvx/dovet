// Write (tools §2): whole-file create or replace.
import { access, constants, lstat, mkdir, readFile, readlink, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { isErrno, lexicalPath, PathRefused } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { lineDelta, placeholderViolation } from "./change-guard.ts";
import { decode, dominantEol, encode, sha256Of, sniffEncoding } from "./codec.ts";
import { newFileEol } from "./eol.ts";
import { canReadWithoutPrompt, fileEffects } from "./policy.ts";
import type { Encoding } from "./read-scan.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.ts";
import { type WriteHooks, writeBytes } from "./write-file.ts";

const WriteInput = z.strictObject({ file_path: z.string().min(1), content: z.string() });
type WriteInput = z.infer<typeof WriteInput>;

const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });

const countLines = (s: string): number => (s === "" ? 0 : s.replace(/\r?\n$/, "").split(/\r?\n/).length);

export function createWriteTool(opts: { hooks?: WriteHooks | undefined } = {}): ToolDefinition<WriteInput> {
  async function run(input: WriteInput, ctx: ToolContext): Promise<ToolOutput> {
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
      return fail(`${requested} is a symlink to ${await readlink(requested)}. Write to the target path instead.`);
    const st = await stat(path).catch((e: unknown) => {
      if (isErrno(e, "ENOENT", "ENOTDIR")) return undefined;
      throw e;
    });
    if (st?.isDirectory()) return fail(`${path} is a directory.`);
    if (st !== undefined && !st.isFile()) return fail(`${path} is not a regular file.`);

    let before: Uint8Array | null = null;
    let oldText = "";
    let encoding: Encoding = "utf8";
    let eol: "\n" | "\r\n";
    if (st === undefined) {
      eol = await newFileEol(path);
    } else {
      let known = ctx.readState.get(path);
      const spellings = requested === path ? [path] : [requested, path];
      if (known === undefined && !path.endsWith(".ipynb") && canReadWithoutPrompt(ctx, spellings)) {
        const silent = await readFile(path);
        const silentEncoding = sniffEncoding(silent);
        const silentText = decode(silent, silentEncoding);
        const silentStat = await stat(path);
        ctx.readState.set(path, {
          sha256: sha256Of(silent),
          mtimeMs: silentStat.mtimeMs,
          size: silentStat.size,
          partial: false,
          encoding: silentEncoding,
          eol: silentText.includes("\r\n") && /(^|[^\r])\n/.test(silentText) ? "mixed" : dominantEol(silentText, "\n"),
        });
        known = ctx.readState.get(path);
      }
      if (known === undefined || known.partial)
        return fail(`You must Read ${path} in full before overwriting it. Use Edit for a partial change.`);
      try {
        await access(path, constants.W_OK);
      } catch (e) {
        if (!isErrno(e, "EACCES", "EPERM", "EROFS")) throw e;
        return fail(
          `${path} is read-only. Version control tools such as Perforce keep files read-only until checked out; ask the user.`,
        );
      }
      before = await readFile(path);
      if (sha256Of(before) !== known.sha256)
        return fail(
          `${path} changed since you read it (someone else edited it). Read it again before overwriting, or use Edit.`,
        );
      encoding = known.encoding;
      if (encoding === "invalid" && input.content.includes("�"))
        return fail(
          `${path} is not valid UTF-8 and content contains U+FFFD; writing it would store the garbled characters. Use Edit on the exact bytes you mean to change.`,
        );
      oldText = decode(before, encoding);
      eol = dominantEol(oldText, known.eol);
    }

    const violation = placeholderViolation(oldText, input.content);
    if (violation !== undefined) return fail(violation);

    const body = input.content.replace(/\r\n/g, "\n");
    const bytes = encode(eol === "\r\n" ? body.replace(/\n/g, "\r\n") : body, encoding);
    await mkdir(dirname(path), { recursive: true });
    await ctx.recordWrite(path, before);
    const res = await writeBytes(path, bytes, {
      os: ctx.platform.os,
      hooks: opts.hooks,
      ...(ctx.keepHardLink === true ? { keepHardLink: true } : {}),
    });
    if (!res.ok) return fail(res.appeared ? `${res.message} Read ${path} in full, then write again.` : res.message);

    const after = await stat(path);
    ctx.readState.set(path, {
      sha256: sha256Of(bytes),
      mtimeMs: after.mtimeMs,
      size: after.size,
      partial: false,
      encoding: encoding === "invalid" ? "utf8" : encoding,
      eol,
    });
    const { added, removed } = lineDelta(oldText, input.content);
    const summary =
      st === undefined
        ? `Created ${path} (${countLines(input.content)} lines)`
        : `Updated ${path} (+${added} −${removed} lines)`;
    return {
      status: "ok",
      content: [{ kind: "text", text: [summary, ...res.notes].join("\n") }],
      meta: { fileChanges: [{ path, op: st === undefined ? "create" : "modify", added, removed }] },
    };
  }

  return {
    name: "Write",
    input: WriteInput,
    descriptionFile: "tools/Write.md",
    errorExample: { file_path: "src/index.ts", content: "export {};\n" },
    parallelSafe: false,
    mutates: "files",
    normalize: { aliases: { path: "file_path", filePath: "file_path", contents: "content", text: "content" } },
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
      return { kind: "edit", paths, effects: fileEffects(ctx, "edit", paths) };
    },
    run,
  };
}

export const writeTool = createWriteTool();
