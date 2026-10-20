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
import { formatKey, locate, type Parsed, parseSettingsText } from "./parse.ts";
import { readSettingsText } from "./read.ts";
import { type ProjectTrust, restrictUntrusted, type UntrustedSettings } from "./trust.ts";
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
  /** Required: a caller that forgets to decide gets a compile error, not silent trust. */
  trust: ProjectTrust;
};

export type LoadedSettings = {
  settings: Settings;
  rules: Record<RuleKind, SourcedRule[]>;
  warnings: Problem[];
  notices: string[];
  files: Array<{ source: SettingsSource; path: string }>;
  /** Repo-supplied files that lost settings because the folder isn't trusted; the trust dialog lists these. */
  untrusted: UntrustedSettings[];
};

type Collected = {
  layers: Layer[];
  warnings: Problem[];
  problems: Problem[];
  notices: string[];
  files: LoadedSettings["files"];
  untrusted: UntrustedSettings[];
};

/** Settings from a repo-supplied file: everything in a trusted folder, only what restricts in an untrusted one. */
function withTrust(settings: Settings, file: string, trusted: boolean, out: Collected): Settings {
  if (trusted) return settings;
  const { kept, ignored, allowRules } = restrictUntrusted(settings);
  if (ignored.length === 0) return kept;
  out.untrusted.push({ file, allowRules, ignored });
  const shown =
    ignored.length > 4 ? `${ignored.slice(0, 4).join(", ")} and ${ignored.length - 4} more` : ignored.join(", ");
  out.warnings.push({
    file,
    key: "",
    message: `this folder isn't trusted, so ${allowRules} allow rules and these settings are ignored: ${shown}`,
  });
  return kept;
}

async function loadDovetFile(
  input: LoadInput,
  source: SettingsSource,
  path: string,
  trusted: boolean,
  out: Collected,
): Promise<void> {
  try {
    let text = await readSettingsText(path);
    if (text === undefined) return;
    out.files.push({ source, path });
    let parsed: Parsed = parseSettingsText(text, path);
    let located = true;
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
      located = confirmed;
    }
    const result = validateSettings(parsed.value, {
      file: path,
      duplicates: parsed.duplicates,
      ...(located ? { text, tree: parsed.tree } : {}),
    });
    out.warnings.push(...result.warnings);
    out.problems.push(...result.problems);
    if (source !== "user") {
      for (const [name, provider] of Object.entries(result.value.providers ?? {})) {
        if (!provider.apiKey?.startsWith("cmd:")) continue;
        out.problems.push({
          file: path,
          line: located ? locate(text, parsed.tree, ["providers", name, "apiKey"]) : undefined,
          key: formatKey(["providers", name, "apiKey"]),
          message: "cmd: keys run a program, so they are allowed only in user settings",
        });
      }
    }
    out.layers.push({
      source,
      file: path,
      settings:
        source === "project" || source === "local"
          ? trusted
            ? withoutRefusedEnv(result.value, path, out)
            : withTrust(result.value, path, false, out)
          : result.value,
    });
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    out.problems.push(...err.problems);
  }
}

// cli-config "env": these names could redirect code execution, so a repo's settings never set them, trusted or not.
const PROJECT_ENV_REFUSED =
  /^(PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|NODE_OPTIONS|BUN_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|PYTHONSTARTUP|GIT_.*)$/i;

function withoutRefusedEnv(settings: Settings, file: string, out: Collected): Settings {
  if (settings.env === undefined) return settings;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(settings.env)) {
    if (!PROJECT_ENV_REFUSED.test(name)) {
      kept[name] = value;
      continue;
    }
    out.warnings.push({
      file,
      key: formatKey(["env", name]),
      message: `${name} is ignored in project settings (it could redirect code execution); set it in your user settings`,
    });
  }
  return { ...settings, env: kept };
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

// ASSUMPTION (QUESTIONS Q20): only the portable subset is read, and anything invalid in it is a warning, not a startup error.
async function loadClaudeFile(
  source: SettingsSource,
  path: string,
  shown: string,
  trusted: boolean,
  out: Collected,
): Promise<void> {
  try {
    const text = await readSettingsText(path);
    if (text === undefined) return;
    const parsed = parseSettingsText(text, path);
    const result = validateSettings(portableSubset(parsed.value), {
      file: path,
      text,
      tree: parsed.tree,
      lenient: true,
      duplicates: parsed.duplicates.filter(([section]) => section === "permissions" || section === "sandbox"),
    });
    out.warnings.push(...result.warnings, ...result.problems);
    const settings = source.endsWith("-user") ? result.value : withTrust(result.value, path, trusted, out);
    const permissions = settings.permissions;
    const count =
      (permissions?.allow?.length ?? 0) + (permissions?.ask?.length ?? 0) + (permissions?.deny?.length ?? 0);
    out.files.push({ source, path });
    out.layers.push({ source, file: path, settings });
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
  const own: Collected = { layers: [], warnings: [], problems: [], notices: [], files: [], untrusted: [] };
  await loadDovetFile(input, "user", join(input.dirs.config, "settings.json"), true, own);
  await loadDovetFile(input, "project", join(dovet, "settings.json"), input.trust.project, own);
  await loadDovetFile(input, "local", join(dovet, "settings.local.json"), input.trust.local, own);

  const env = envSettings(input.env);
  const top: Layer[] = [{ source: "env", settings: env.settings }];
  if (input.flags !== undefined) top.push({ source: "flags", settings: input.flags });
  // ASSUMPTION (QUESTIONS Q20): a repo's own settings can turn off only the Claude Code files of that repo, never the user's ~/.claude rules.
  const compatOf = (layers: Layer[]) => mergeLayers(layers).compat?.claudeCodeSettings !== false;
  const userCompat = compatOf([...own.layers.filter((l) => l.source === "user"), ...top]);
  const projectCompat = compatOf([...own.layers, ...top]);

  const theirs: Collected = { layers: [], warnings: [], problems: [], notices: [], files: [], untrusted: [] };
  if (userCompat) {
    await loadClaudeFile(
      "claude-user",
      join(input.home, ".claude", "settings.json"),
      "~/.claude/settings.json",
      true,
      theirs,
    );
  }
  if (projectCompat) {
    await loadClaudeFile(
      "claude-project",
      join(claude, "settings.json"),
      ".claude/settings.json",
      input.trust.project,
      theirs,
    );
    await loadClaudeFile(
      "claude-local",
      join(claude, "settings.local.json"),
      ".claude/settings.local.json",
      input.trust.local,
      theirs,
    );
  }

  const problems = [...own.problems, ...env.problems];
  if (problems.length > 0) throw new SettingsError(problems);

  // ASSUMPTION (QUESTIONS Q20): each Claude Code file sits just below the Dovet file of the same scope.
  const order: SettingsSource[] = ["claude-user", "user", "claude-project", "project", "claude-local", "local"];
  const byFile = [...theirs.layers, ...own.layers].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  const layers: Layer[] = [{ source: "default", settings: DEFAULTS }, ...byFile, ...top];
  return {
    settings: mergeLayers(layers),
    rules: collectRules(layers),
    warnings: [...own.warnings, ...theirs.warnings, ...env.warnings],
    notices: theirs.notices,
    files: [...theirs.files, ...own.files],
    untrusted: [...theirs.untrusted, ...own.untrusted],
  };
}
