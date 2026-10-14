// Glob (tools §8): `rg --files` for the candidate list, Bun.Glob for standard anchored matching.
import { access, constants, stat } from "node:fs/promises";
import { z } from "zod";
import { isErrno, lexicalPath, PathRefused } from "../platform/index.ts";
import type { AbsPath } from "../schema/index.ts";
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
} from "./rg.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.ts";

const GlobInput = z.strictObject({ pattern: z.string().min(1), path: z.string().min(1).optional() });
type GlobInput = z.infer<typeof GlobInput>;

const MAX_RESULTS = 100;
const MAX_SORT_BY_TIME = 5000;

type Listing = { files: string[]; run: RgRun };

export function createGlobTool(opts: { limits?: Partial<RgLimits> } = {}): ToolDefinition<GlobInput> {
  const limits: RgLimits = { ...DEFAULT_LIMITS, ...opts.limits };

  async function run(input: GlobInput, ctx: ToolContext): Promise<ToolOutput> {
    const cwd = ctx.session.cwd;
    const os = ctx.platform.os;
    const found = await locateRg(ctx);
    if (!isBinary(found)) return found;

    let root: AbsPath;
    try {
      root = ctx.platform.canonicalize(input.path ?? cwd, cwd);
    } catch (e) {
      if (e instanceof PathRefused) return fail(e.message);
      throw e;
    }
    try {
      const st = await stat(root);
      if (!st.isDirectory()) return fail(`${root} is not a directory.`);
      await access(root, constants.R_OK | constants.X_OK);
    } catch (e) {
      if (isErrno(e, "ENOENT", "ENOTDIR")) return fail(`Path not found: ${root}`);
      if (isErrno(e, "EACCES", "EPERM")) return fail(`Permission denied: ${root}`);
      throw e;
    }

    const list = async (noIgnore: boolean): Promise<Listing | ToolOutput> => {
      const result = await runRg(ctx, found.path, [...baseArgs(ctx, noIgnore), "--files"], root, limits);
      if (!isRun(result)) return result;
      const failed = runFailure(result);
      if (failed) return failed;
      const files = result.stdout.split("\n").filter((l) => l !== "");
      return { files: os === "win32" ? files.map((f) => f.replaceAll("\\", "/")) : files, run: result };
    };

    const ignoredRoot = root !== cwd && (await isIgnoredPath(ctx, found.path, cwd, root, limits));
    const showAll = ctx.settings.glob?.respectGitignore === false || ignoredRoot;
    const pattern = input.pattern;
    const matcher = new Bun.Glob(pattern);
    const insensitive = os === "win32" || os === "darwin";
    const foldedMatcher = new Bun.Glob(pattern.toLowerCase());

    const first = await list(showAll);
    if (!("files" in first)) return first;
    let listing = first;
    let matches = listing.files.filter((f) => matcher.match(f));
    const marks: string[] = [];
    if (matches.length === 0 && !showAll && !listing.run.timedOut && !listing.run.capped) {
      const second = await list(true);
      if (!("files" in second)) return second;
      const hits = second.files.filter((f) => matcher.match(f));
      if (hits.length > 0) {
        listing = second;
        matches = hits;
        marks.push("(only in ignored files)");
      }
    }
    if (matches.length === 0 && insensitive) {
      const hits = listing.files.filter((f) => foldedMatcher.match(f.toLowerCase()));
      if (hits.length > 0) {
        matches = hits;
        marks.push("(matched ignoring case)");
      }
    }

    const skipped = (await listSensitive(ctx, found.path, root, ["--"], showAll, limits)).filter(
      (f) => matcher.match(f) || (insensitive && foldedMatcher.match(f.toLowerCase())),
    );
    const notes = [
      found.note,
      readNote(listing.run),
      skipped.length > 0 ? `(${skipped.length} sensitive files skipped)` : undefined,
      partialNote(listing.run, limits),
    ].filter((n): n is string => n !== undefined);
    if (matches.length === 0)
      return reply(
        [listing.run.timedOut || listing.run.capped ? "Nothing found before the search stopped." : "No files found."],
        notes,
      );

    let ordered: string[];
    if (matches.length > MAX_SORT_BY_TIME) {
      ordered = matches.sort();
      marks.push(`(more than ${MAX_SORT_BY_TIME} matches: sorted by path, not by modification time)`);
    } else {
      const times = await Promise.all(
        matches.map(async (f) => {
          try {
            return (await stat(`${root}/${f}`)).mtimeMs;
          } catch (e) {
            if (isErrno(e, "ENOENT", "ENOTDIR", "EACCES")) return 0;
            throw e;
          }
        }),
      );
      ordered = matches
        .map((f, i) => ({ f, t: times[i] ?? 0 }))
        .sort((a, b) => b.t - a.t || (a.f < b.f ? -1 : 1))
        .map((x) => x.f);
    }
    const shown = ordered.slice(0, MAX_RESULTS).map((f) => displayPath(`${root}/${f}`, cwd, os));
    const more = ordered.length - shown.length;
    return reply([...marks, ...shown, ...(more > 0 ? [`[… ${more} more; narrow the pattern]`] : [])], notes);
  }

  const reply = (lines: string[], notes: string[]): ToolOutput => ({
    status: "ok",
    content: [{ kind: "text", text: [...lines, ...notes].join("\n") }],
  });

  return {
    name: "Glob",
    input: GlobInput,
    descriptionFile: "tools/Glob.md",
    errorExample: { pattern: "**/*.ts", path: "src" },
    parallelSafe: true,
    mutates: "none",
    normalize: { aliases: { file_path: "path" } },
    pathFields: ["pattern", "path"],
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
      return {
        kind: "read",
        paths,
        effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
      };
    },
    run,
  };
}

export const globTool = createGlobTool();
