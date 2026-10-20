// Instruction files: discovery, imports, lazy and path-scoped loads, dedupe and policy (context §3).
import type { BigIntStats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { canonicalizePath, isErrno, isWithin, type Os, PathRefused, pathKey } from "../../platform/index.ts";
import type { AbsPath, InstructionsLoadedData, Settings } from "../../schema/index.ts";
import type { ExternalImportApprovals } from "../../store/index.ts";
import { stripHidden } from "../../tools/index.ts";
import { excludeMatcher, findImports, parseRule, stripHtmlComments } from "./instruction-text.ts";
import { type InstructionPart, instructionsUpdated, type LoadedInstruction, lazyInstructions } from "./instructions.ts";

export type InstructionContext = {
  os: Os;
  home: AbsPath;
  configDir: AbsPath;
  /** The session's primary working directory. */
  cwd: AbsPath;
  /** The project root when the session starts below it: its files count as part of the project, not as folders above it. */
  projectRoot?: AbsPath;
  additionalDirs: readonly AbsPath[];
  settings: NonNullable<Settings["instructions"]>;
  contextWindow: number;
  blockReadsOutsideWorkingDirectories: boolean;
  /** `Read` deny rules, judged on the canonical path. */
  readDenied(canonical: AbsPath): boolean;
  approvals: ExternalImportApprovals;
  /** The one-time dialog listing external imports; resolves to whether the user approved them. */
  askExternal(paths: readonly string[]): Promise<boolean>;
};

export type FoundInstruction = {
  path: string;
  status:
    | "loaded"
    | "excluded"
    | "denied"
    | "outside"
    | "declined"
    | "too-large"
    | "binary"
    | "network"
    | "additional-dir";
  reason?: string;
};

export type InstructionSet = {
  /** Launch files in render order, for `renderSystemPrompt` and change detection. */
  files: LoadedInstruction[];
  found: FoundInstruction[];
  warnings: string[];
  /** Files whose hidden-instruction characters set taint (permissions §10); the session applies them. */
  taintSources: string[];
  launchEvent: InstructionsLoadedData;
  /** On resume: launch files whose content changed since they were last sent, as `instructions-updated` parts. */
  resumeUpdates: InstructionPart[];
  /** After a file is read, written, created or edited: instruction files that now apply. */
  touch(path: string): Promise<LazyLoad>;
  touchMentions(message: string): Promise<LazyLoad>;
};

export type LazyLoad = {
  parts: InstructionPart[];
  /** The files just attached, for change detection. */
  files: LoadedInstruction[];
  event?: InstructionsLoadedData;
  notes: string[];
};

type Trigger = InstructionsLoadedData["files"][number]["trigger"];
type Scoped = { requested: string; base: string; globs: Bun.Glob[]; project: boolean };

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_HOPS = 4;
const CLAUDE_FAMILY = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
const AGENTS_FAMILY = ["AGENTS.md", ".claude/AGENTS.md"];
const RULE_DIRS = [".dovet/rules", ".claude/rules"];

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const lineCount = (text: string): number => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

/** Windows file IDs are 64-bit; as a double, neighbouring files can share one, so identity uses bigint. */
export const fileIdentityKey = (s: { dev: bigint; ino: bigint }): string | undefined =>
  s.ino === 0n ? undefined : `${s.dev}:${s.ino}`;

/** A file the agent can swap for a loop, a vanished path or a locked folder mid-turn counts as not loadable, never as a crash. */
const UNREADABLE = ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "EISDIR", "ENAMETOOLONG"] as const;

async function statOrNull(p: string): Promise<BigIntStats | null> {
  return stat(p, { bigint: true }).catch((e: unknown) => (isErrno(e, ...UNREADABLE) ? null : Promise.reject(e)));
}

async function readOrNull(p: string): Promise<Buffer | null> {
  return readFile(p).catch((e: unknown) => (isErrno(e, ...UNREADABLE) ? null : Promise.reject(e)));
}

export async function discoverInstructions(
  ctx: InstructionContext,
  resume: { loaded?: readonly InstructionsLoadedData[] } = {},
): Promise<InstructionSet> {
  let set = await build(ctx, resume);
  // An approved external file can import further external files; each round asks only about new ones.
  while (set.pending.length > 0) {
    const approved = await ctx.askExternal(set.pending);
    await ctx.approvals.record(set.pending, approved);
    set = await build(ctx, resume);
  }
  return set.api;
}

async function build(
  ctx: InstructionContext,
  resume: { loaded?: readonly InstructionsLoadedData[] },
): Promise<{ api: InstructionSet; pending: string[] }> {
  const { os, cwd, settings } = ctx;
  const path = os === "win32" ? win32 : posix;
  const canon = (p: string): AbsPath => canonicalizePath(p, cwd, os);
  const workingDirs = [cwd, ...(ctx.projectRoot === undefined ? [] : [ctx.projectRoot])].map(canon);
  const additional: { dir: string; canonical: AbsPath }[] = [];
  const unresolved: string[] = [];
  for (const dir of ctx.additionalDirs) {
    try {
      const canonical = canon(dir);
      additional.push({ dir, canonical });
      workingDirs.push(canonical);
    } catch (e) {
      if (!(e instanceof PathRefused) && !isErrno(e, ...UNREADABLE)) throw e;
      unresolved.push(dir);
    }
  }
  const inWorkingDirs = (p: string): boolean => workingDirs.some((d) => isWithin(p, d, os));
  const excluded = excludeMatcher(settings.exclude ?? []);
  const scale = Math.min(4, ctx.contextWindow / 200_000);
  const seen = new Set<string>();
  const found: FoundInstruction[] = [];
  const warnings: string[] = [];
  const taintSources: string[] = [];
  const pending = new Set<string>();
  const scoped: Scoped[] = [];
  const scanned = new Set<string>();
  let launching = true;

  const display = (p: string): string => {
    if (isWithin(p, cwd, os)) return path.relative(cwd, p) || path.basename(p);
    if (isWithin(p, ctx.home, os)) return `~${path.sep}${path.relative(ctx.home, p)}`;
    return isWithin(cwd, path.dirname(p), os) ? path.relative(cwd, p) : p;
  };

  /** Network paths are refused before anything touches them: Windows would send credentials to a share. */
  function canonOrRefusal(p: string): AbsPath | { refused: string; status: FoundInstruction["status"] } {
    let canonical: AbsPath;
    try {
      canonical = canon(p);
    } catch (e) {
      if (e instanceof PathRefused) return { refused: e.message, status: "network" };
      if (isErrno(e, ...UNREADABLE)) return { refused: "cannot be read", status: "denied" };
      throw e;
    }
    if (os === "darwin" && /^\/(Network|\.vol)\//i.test(canonical))
      return { refused: "network paths are never read", status: "network" };
    return canonical;
  }

  type Admitted = { canonical: AbsPath; keys: string[]; mtimeMs: number };
  /** Every policy check, before a single byte is read. `project`: reached from inside the working directories. */
  async function admit(requested: string, project: boolean): Promise<Admitted | undefined> {
    const shown = display(requested);
    const refuse = (status: FoundInstruction["status"], reason: string): undefined => {
      found.push({ path: shown, status, reason });
      return undefined;
    };
    const canonical = canonOrRefusal(requested);
    if (typeof canonical !== "string") return refuse(canonical.status, canonical.refused);
    const info = await statOrNull(requested);
    if (info === null || !info.isFile()) return undefined;
    const identity = fileIdentityKey(info);
    const keys = [pathKey(canonical, os), ...(identity === undefined ? [] : [identity])];
    if (keys.some((k) => seen.has(k))) return undefined;
    const rel = (p: string): string | undefined => (isWithin(p, cwd, os) ? path.relative(cwd, p) : undefined);
    if (excluded(rel(requested), requested) || excluded(rel(canonical), canonical)) {
      return refuse("excluded", "matches instructions.exclude");
    }
    if (ctx.readDenied(canonical)) return refuse("denied", "denied by a Read rule");
    if (info.size > BigInt(MAX_BYTES)) {
      warnings.push(`${shown} skipped: larger than 4 MiB`);
      return refuse("too-large", "larger than 4 MiB");
    }
    // ASSUMPTION (QUESTIONS Q30): only files reached from inside the working directories count as external.
    if (project && !inWorkingDirs(canonical)) {
      if (ctx.blockReadsOutsideWorkingDirectories) {
        return refuse("outside", `resolves to ${canonical}, outside the working directories`);
      }
      let approved = await ctx.approvals.decision(canonical);
      if (approved === undefined && launching) {
        pending.add(canonical);
        return refuse("declined", "external import waiting for approval");
      }
      if (approved === undefined) {
        approved = await ctx.askExternal([canonical]);
        await ctx.approvals.record([canonical], approved);
      }
      if (!approved) {
        warnings.push(`${shown} not loaded: the external import ${canonical} was declined`);
        return refuse("declined", "external import declined");
      }
    }
    return { canonical, keys, mtimeMs: Number(info.mtimeNs) / 1e6 };
  }

  type Loaded = { file: LoadedInstruction; records: InstructionsLoadedData["files"] };
  async function load(
    requested: string,
    opts: { project: boolean; trigger: Trigger; rule?: boolean; admitted?: Admitted },
    stack: { key: string; name: string }[] = [],
  ): Promise<Loaded | undefined> {
    const admitted = opts.admitted ?? (await admit(requested, opts.project));
    if (admitted === undefined) return undefined;
    const read = await readOrNull(requested);
    if (read === null) {
      found.push({ path: display(requested), status: "denied", reason: "cannot be read" });
      return undefined;
    }
    const bytes = new Uint8Array(read);
    if (bytes.subarray(0, 8000).includes(0)) {
      warnings.push(`${display(requested)} skipped: binary file`);
      found.push({ path: display(requested), status: "binary", reason: "binary file" });
      return undefined;
    }
    for (const k of admitted.keys) seen.add(k);
    found.push({ path: display(requested), status: "loaded" });
    const raw = new TextDecoder().decode(bytes);
    const records: InstructionsLoadedData["files"] = [
      {
        path: admitted.canonical,
        sha256: sha256(bytes),
        bytes: bytes.length,
        lines: lineCount(raw),
        trigger: opts.trigger,
      },
    ];
    let text = raw;
    if (opts.rule === true) {
      const rule = parseRule(raw);
      if (rule.warning !== undefined) warnings.push(`${display(requested)}: ${rule.warning}`);
      text = rule.body;
    }
    text = stripHtmlComments(text);
    const chain = [...stack, { key: admitted.keys[0] ?? "", name: display(requested) }];
    let out = "";
    let at = 0;
    for (const ref of findImports(text)) {
      const target = ref.path.startsWith("~/")
        ? path.join(ctx.home, ref.path.slice(2))
        : path.resolve(path.dirname(requested), ref.path);
      // ASSUMPTION (QUESTIONS Q30): the token is replaced by the imported text; a skipped import leaves it.
      const replacement = await inline(target, chain, opts.project, records);
      if (replacement === undefined) continue;
      out += text.slice(at, ref.index) + replacement;
      at = ref.index + ref.length;
    }
    out += text.slice(at);
    if (records[0] !== undefined && records[0].lines > 200 * scale) {
      warnings.push(
        `${display(requested)} has ${records[0].lines} lines (over ${Math.round(200 * scale)}); long instructions are followed less reliably`,
      );
    }
    const stripped = stripHidden(out);
    if (stripped.removed > 0) {
      warnings.push(
        `${display(requested)}: ${stripped.removed} hidden characters removed; the file on disk is unchanged`,
      );
      taintSources.push(admitted.canonical);
    }
    return {
      file: {
        path: admitted.canonical,
        displayPath: display(requested),
        content: stripped.text,
        mtimeMs: admitted.mtimeMs,
        sha256: records[0]?.sha256 ?? "",
      },
      records,
    };
  }

  async function inline(
    target: string,
    chain: { key: string; name: string }[],
    project: boolean,
    records: InstructionsLoadedData["files"],
  ): Promise<string | undefined> {
    const canonical = canonOrRefusal(target);
    if (typeof canonical !== "string") {
      found.push({ path: display(target), status: canonical.status, reason: canonical.refused });
      return undefined;
    }
    if ((await statOrNull(target)) === null) return undefined;
    const key = pathKey(canonical, os);
    const cycleAt = chain.findIndex((c) => c.key === key);
    if (cycleAt !== -1) {
      warnings.push(
        `import cycle: ${[...chain.slice(cycleAt).map((c) => c.name), display(target)].join(" → ")}; broken there`,
      );
      return undefined;
    }
    if (chain.length > MAX_HOPS) {
      warnings.push(`${display(target)} not imported: import depth limit (${MAX_HOPS} hops) reached`);
      return undefined;
    }
    const loaded = await load(target, { project, trigger: "import" }, chain);
    if (loaded === undefined) return undefined;
    records.push(...loaded.records);
    return loaded.file.content.replace(/\r?\n$/, "");
  }

  async function ruleFiles(roots: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const root of roots) {
      if (!(await statOrNull(root))?.isDirectory()) continue;
      // One locked subfolder aborts the whole scan: the folder's rules count as not loadable rather than crash a reload.
      const names = await Array.fromAsync(
        new Bun.Glob("**/*.md").scan({ cwd: root, dot: true, followSymlinks: true }),
      ).catch((e: unknown) => (isErrno(e, ...UNREADABLE) ? null : Promise.reject(e)));
      if (names === null) {
        found.push({ path: display(root), status: "denied", reason: "cannot be read" });
        continue;
      }
      out.push(...names.sort().map((n) => path.join(root, n)));
    }
    return out;
  }

  // ASSUMPTION (QUESTIONS Q30): `agents-md-or-claude-md` is judged per directory.
  async function familyFiles(dir: string): Promise<string[]> {
    const choice = settings.files ?? "both";
    const at = (names: string[]): string[] => names.map((n) => path.join(dir, n));
    if (choice === "claude-md") return at(CLAUDE_FAMILY);
    if (choice === "agents-md") return at(AGENTS_FAMILY);
    if (choice === "both") return at([...CLAUDE_FAMILY, ...AGENTS_FAMILY]);
    for (const f of at(CLAUDE_FAMILY)) if ((await statOrNull(f))?.isFile()) return at(CLAUDE_FAMILY);
    return at(AGENTS_FAMILY);
  }

  /** Main files, then unscoped rules at the same priority; a scoped rule waits for a matching file under `dir`. */
  async function loadDir(
    dir: string,
    project: boolean,
    trigger: Trigger,
    files?: { main: readonly string[]; rules: readonly string[] },
  ): Promise<Loaded[]> {
    if (files === undefined) scanned.add(pathKey(dir, os));
    const out: Loaded[] = [];
    const main = files?.main ?? (await familyFiles(dir));
    for (const f of main) {
      const l = await load(f, { project, trigger });
      if (l !== undefined) out.push(l);
    }
    for (const f of await ruleFiles(files?.rules ?? RULE_DIRS.map((r) => path.join(dir, r)))) {
      const admitted = await admit(f, project);
      if (admitted === undefined) continue;
      const ruleBytes = await readOrNull(f);
      if (ruleBytes === null) {
        found.push({ path: display(f), status: "denied", reason: "cannot be read" });
        continue;
      }
      const rule = parseRule(ruleBytes.toString("utf8"));
      if (rule.paths !== undefined) {
        scoped.push({ requested: f, base: dir, globs: rule.paths.map((p) => new Bun.Glob(p)), project });
        continue;
      }
      const l = await load(f, { project, trigger, rule: true, admitted });
      if (l !== undefined) out.push(l);
    }
    return out;
  }

  for (const dir of unresolved) found.push({ path: display(dir), status: "denied", reason: "cannot be read" });
  const launch: Loaded[] = [];
  const claudeHome = path.join(ctx.home, ".claude");
  // User-level scoped rules match paths relative to the working directory.
  launch.push(
    ...(await loadDir(cwd, false, "launch", {
      main: [path.join(ctx.configDir, "AGENTS.md")],
      rules: [path.join(ctx.configDir, "rules")],
    })),
  );
  if (settings.readClaudeUserFiles !== false) {
    launch.push(
      ...(await loadDir(cwd, false, "launch", {
        main: [path.join(claudeHome, "CLAUDE.md")],
        rules: [path.join(claudeHome, "rules")],
      })),
    );
  }
  const ancestors: string[] = [];
  for (let d = cwd; ; d = path.dirname(d)) {
    ancestors.unshift(d);
    if (path.dirname(d) === d) break;
  }
  for (const d of ancestors) {
    if (pathKey(d, os) !== pathKey(ctx.home, os)) {
      launch.push(...(await loadDir(d, inWorkingDirs(canon(d)), "launch")));
      continue;
    }
    // The home folder's .claude/ files are user-level (readClaudeUserFiles), never part of the walk.
    const main = (await familyFiles(d)).filter((f) => !isWithin(f, claudeHome, os));
    launch.push(
      ...(await loadDir(d, inWorkingDirs(canon(d)), "launch", { main, rules: [path.join(d, ".dovet", "rules")] })),
    );
  }
  for (const { dir: d, canonical } of additional) {
    if (isWithin(canonical, workingDirs[0] ?? cwd, os) || settings.fromAdditionalDirectories === true) {
      launch.push(...(await loadDir(d, true, "launch")));
      continue;
    }
    for (const f of await familyFiles(d)) {
      if ((await statOrNull(f))?.isFile()) {
        found.push({
          path: display(f),
          status: "additional-dir",
          reason: "instructions.fromAdditionalDirectories is off",
        });
      }
    }
  }
  const total = launch.reduce((n, l) => n + l.records.reduce((m, r) => m + r.lines, 0), 0);
  if (total > 1000 * scale) {
    warnings.push(
      `instruction files total ${total} lines (over ${Math.round(1000 * scale)}); long instructions are followed less reliably`,
    );
  }
  launching = false;
  const resumed = new Map<string, string>();
  for (const e of resume.loaded ?? []) {
    for (const gone of e.dropped ?? []) resumed.delete(pathKey(gone, os));
    for (const f of e.files) resumed.set(pathKey(f.path, os), f.sha256);
  }
  const resumeUpdates: InstructionPart[] = [];
  if ((resume.loaded?.length ?? 0) > 0) {
    for (const l of launch) {
      const before = l.records.map((r) => resumed.get(pathKey(r.path, os)));
      if (before[0] === undefined) resumeUpdates.push(lazyInstructions(l.file.displayPath, l.file.content));
      else if (l.records.some((r, i) => before[i] !== r.sha256)) {
        resumeUpdates.push(instructionsUpdated(l.file.displayPath, l.file.content));
      }
    }
  }
  // Files attached during the resumed epoch stay attached; only a new epoch resets that.
  for (const p of resumed.keys()) {
    seen.add(p);
    const info = await statOrNull(p);
    const identity = info === null ? undefined : fileIdentityKey(info);
    if (identity !== undefined) seen.add(identity);
  }
  const launchEvent: InstructionsLoadedData = { files: launch.flatMap((l) => l.records), warnings: [...warnings] };

  async function touch(target: string): Promise<LazyLoad> {
    const before = { found: found.length, warnings: warnings.length };
    const requested = path.resolve(cwd, target);
    const canonical = canonOrRefusal(requested);
    if (typeof canonical !== "string")
      return { parts: [], files: [], notes: [`${target} ignored: ${canonical.refused}`] };
    const loaded: Loaded[] = [];
    for (const p of new Set([requested, canonical])) {
      if (!isWithin(p, cwd, os)) continue;
      const dirs: string[] = [];
      for (let d = path.dirname(p); isWithin(d, cwd, os) && pathKey(d, os) !== pathKey(cwd, os); d = path.dirname(d))
        dirs.unshift(d);
      for (const d of dirs) {
        if (scanned.has(pathKey(d, os)) || !(await statOrNull(d))?.isDirectory()) continue;
        loaded.push(...(await loadDir(d, true, "lazy-subdir")));
      }
    }
    for (const rule of [...scoped]) {
      const rel = [requested, canonical]
        .filter((p) => isWithin(p, rule.base, os))
        .map((p) => path.relative(rule.base, p).replaceAll("\\", "/"));
      if (!rule.globs.some((g) => rel.some((r) => g.match(r)))) continue;
      scoped.splice(scoped.indexOf(rule), 1);
      const l = await load(rule.requested, { project: rule.project, trigger: "path-rule", rule: true });
      if (l !== undefined) loaded.push(l);
    }
    const notes = found
      .slice(before.found)
      .filter((f) => f.status !== "loaded")
      .map((f) => `${f.path} exists but wasn't loaded: ${f.reason ?? f.status}`);
    if (loaded.length === 0) return { parts: [], files: [], notes };
    return {
      parts: loaded.map((l) => lazyInstructions(l.file.displayPath, l.file.content)),
      files: loaded.map((l) => l.file),
      event: { files: loaded.flatMap((l) => l.records), warnings: warnings.slice(before.warnings) },
      notes,
    };
  }

  const api: InstructionSet = {
    files: launch.map((l) => l.file),
    resumeUpdates,
    found,
    warnings,
    taintSources,
    launchEvent,
    touch,
    async touchMentions(message) {
      const all: LazyLoad = { parts: [], files: [], notes: [] };
      for (const ref of findImports(message)) {
        const r = await touch(ref.path);
        all.parts.push(...r.parts);
        all.notes.push(...r.notes);
        all.files.push(...r.files);
        if (r.event !== undefined) {
          all.event = {
            files: [...(all.event?.files ?? []), ...r.event.files],
            warnings: [...(all.event?.warnings ?? []), ...r.event.warnings],
          };
        }
      }
      return all;
    },
  };
  return { api, pending: [...pending] };
}
