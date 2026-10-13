import { join } from "node:path";
import type { Settings } from "../../schema/index.ts";
import { DEFAULTS } from "./defaults.ts";
import { envSettings } from "./env.ts";
import { type Problem, SettingsError } from "./errors.ts";
import {
  collectRules,
  type Layer,
  mergeLayers,
  type RuleKind,
  type SettingsSource,
  type SourcedRule,
} from "./merge.ts";
import { fileVersion, MIGRATIONS, type Migration, migrateText, type PendingMigration } from "./migrate.ts";
import { type Parsed, parseSettingsText } from "./parse.ts";
import { readSettingsText } from "./read.ts";
import { validateSettings } from "./validate.ts";
import { writeFileAtomic } from "./write.ts";

export type LoadInput = {
  dirs: { config: string };
  home: string;
  projectRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  flags?: Settings;
  migrations?: readonly Migration[];
  /** Asked once per file that needs a rewrite; without it (or on false) the mapping applies in memory with a warning. */
  confirmMigration?: (pending: PendingMigration) => Promise<boolean>;
};

export type LoadedSettings = {
  settings: Settings;
  rules: Record<RuleKind, SourcedRule[]>;
  warnings: Problem[];
  notices: string[];
  files: Array<{ source: SettingsSource; path: string }>;
};

type Collected = {
  layers: Layer[];
  warnings: Problem[];
  problems: Problem[];
  notices: string[];
  files: LoadedSettings["files"];
};

async function loadDovetFile(input: LoadInput, source: SettingsSource, path: string, out: Collected): Promise<void> {
  try {
    let text = await readSettingsText(path);
    if (text === undefined) return;
    out.files.push({ source, path });
    let parsed: Parsed = parseSettingsText(text, path);
    const plan = migrateText(text, fileVersion(parsed.value), input.migrations ?? MIGRATIONS);
    if (plan.changes.length > 0) {
      const confirmed = (await input.confirmMigration?.({ file: path, changes: plan.changes })) ?? false;
      if (confirmed) {
        await writeFileAtomic(path, plan.text);
      } else {
        out.warnings.push({
          file: path,
          key: "",
          message: `uses old settings; applied in memory only (${plan.changes.join("; ")}). Update the file to silence this`,
        });
      }
      text = plan.text;
      parsed = parseSettingsText(text, path);
    }
    const result = validateSettings(parsed.value, { file: path, text, tree: parsed.tree });
    out.warnings.push(...result.warnings);
    out.problems.push(...result.problems);
    out.layers.push({ source, file: path, settings: result.value });
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    out.problems.push(...err.problems);
  }
}

const PORTABLE_PERMISSION_KEYS = ["allow", "ask", "deny", "additionalDirectories", "defaultMode"] as const;

function portableSubset(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const { permissions, sandbox } = raw as { permissions?: unknown; sandbox?: unknown };
  const subset: Record<string, unknown> = {};
  if (typeof permissions === "object" && permissions !== null && !Array.isArray(permissions)) {
    const kept: Record<string, unknown> = {};
    for (const key of PORTABLE_PERMISSION_KEYS) {
      if (key in permissions) kept[key] = (permissions as Record<string, unknown>)[key];
    }
    subset.permissions = kept;
  }
  if (sandbox !== undefined) subset.sandbox = sandbox;
  return subset;
}

async function loadClaudeFile(source: SettingsSource, path: string, shown: string, out: Collected): Promise<void> {
  try {
    const text = await readSettingsText(path);
    if (text === undefined) return;
    const parsed = parseSettingsText(text, path);
    const result = validateSettings(portableSubset(parsed.value), {
      file: path,
      text,
      tree: parsed.tree,
      lenient: true,
    });
    out.warnings.push(...result.warnings, ...result.problems);
    const permissions = result.value.permissions;
    const count =
      (permissions?.allow?.length ?? 0) + (permissions?.ask?.length ?? 0) + (permissions?.deny?.length ?? 0);
    out.files.push({ source, path });
    out.layers.push({ source, file: path, settings: result.value });
    if (count > 0) out.notices.push(`Using ${count} permission rules from ${shown}`);
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    out.warnings.push(...err.problems);
  }
}

/** Reads every level of the precedence chain (cli-config "Config files and precedence") and merges them, lowest first. */
export async function loadSettings(input: LoadInput): Promise<LoadedSettings> {
  const dovet = join(input.projectRoot, ".dovet");
  const claude = join(input.projectRoot, ".claude");
  const own: Collected = { layers: [], warnings: [], problems: [], notices: [], files: [] };
  await loadDovetFile(input, "user", join(input.dirs.config, "settings.json"), own);
  await loadDovetFile(input, "project", join(dovet, "settings.json"), own);
  await loadDovetFile(input, "local", join(dovet, "settings.local.json"), own);

  const env = envSettings(input.env);
  const top: Layer[] = [{ source: "env", settings: env.settings }];
  if (input.flags !== undefined) top.push({ source: "flags", settings: input.flags });
  const compat = mergeLayers([...own.layers, ...top]).compat?.claudeCodeSettings !== false;

  const theirs: Collected = { layers: [], warnings: [], problems: [], notices: [], files: [] };
  if (compat) {
    await loadClaudeFile(
      "claude-user",
      join(input.home, ".claude", "settings.json"),
      "~/.claude/settings.json",
      theirs,
    );
    await loadClaudeFile("claude-project", join(claude, "settings.json"), ".claude/settings.json", theirs);
    await loadClaudeFile("claude-local", join(claude, "settings.local.json"), ".claude/settings.local.json", theirs);
  }

  const problems = [...own.problems, ...env.problems];
  if (problems.length > 0) throw new SettingsError(problems);

  const order: SettingsSource[] = ["claude-user", "user", "claude-project", "project", "claude-local", "local"];
  const byFile = [...theirs.layers, ...own.layers].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  const layers: Layer[] = [{ source: "default", settings: DEFAULTS }, ...byFile, ...top];
  return {
    settings: mergeLayers(layers),
    rules: collectRules(layers),
    warnings: [...own.warnings, ...theirs.warnings, ...env.warnings],
    notices: theirs.notices,
    files: [...theirs.files, ...own.files],
  };
}
