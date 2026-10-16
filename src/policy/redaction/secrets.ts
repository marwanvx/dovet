// The redaction set (permissions §8, §4.7): secret-named env vars and workspace `.env*` values.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "./dotenv.ts";

export type NamedSecret = { name: string; value: string };

/** Values shorter than this never redact by value (ASSUMPTION QUESTIONS Q60): they match ordinary words. */
export const MIN_SECRET_VALUE_LENGTH = 8;

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export function secretsFromEnv(env: Readonly<Record<string, string | undefined>>): NamedSecret[] {
  const out: NamedSecret[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_VALUE_LENGTH || !SECRET_NAME.test(name)) continue;
    if (out.some((s) => s.name === name)) continue;
    out.push({ name, value });
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "target", "dist", "build", ".venv", "__pycache__"]);
const ENV_BASENAME = /^\.env(\..+)?$/;
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/;

const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
};

function scanDir(dir: string, found: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (!SKIP_DIRS.has(name)) scanDir(full, found);
    } else if (ENV_BASENAME.test(name) && !TEMPLATE_SUFFIX.test(name)) {
      found.push(full);
    }
  }
}

const readSecretsFile = (path: string): NamedSecret[] => {
  try {
    return secretsFromEnv(parseEnvFile(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
};

export type DotEnvSecrets = { current(): NamedSecret[] };

/** Workspace `.env*` values at session start and whenever the files change (permissions §4.7). */
export function createDotEnvSecrets(dirs: readonly string[]): DotEnvSecrets {
  let scanned = false;
  const rootMtime = new Map<string, number>();
  let files: string[] = [];
  const fileMtime = new Map<string, number>();
  const perFile = new Map<string, NamedSecret[]>();
  return {
    current(): NamedSecret[] {
      let rescan = !scanned;
      for (const d of dirs) {
        const m = mtimeOf(d);
        if (rootMtime.get(d) !== m) {
          rootMtime.set(d, m);
          rescan = true;
        }
      }
      if (rescan) {
        const found: string[] = [];
        for (const d of dirs) scanDir(d, found);
        files = found.sort();
        scanned = true;
      }
      for (const f of files) {
        const m = mtimeOf(f);
        if (fileMtime.get(f) === m) continue;
        fileMtime.set(f, m);
        perFile.set(f, m < 0 ? [] : readSecretsFile(f));
      }
      for (const known of [...perFile.keys()]) if (!files.includes(known)) perFile.delete(known);
      return files.flatMap((f) => perFile.get(f) ?? []);
    },
  };
}
