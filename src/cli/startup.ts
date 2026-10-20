// Headless startup helpers (cli-config "Startup sequence", "Piped input", "Data and privacy").
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isErrno } from "../platform/index.ts";

const INHERITED = ["DOVET", "DOVET_RUN", "DOVET_SNAPSHOT", "AI_AGENT"] as const;

export function filterInheritedEnv(env: Readonly<Record<string, string | undefined>>): {
  clean: Record<string, string | undefined>;
  ignored: string[];
} {
  const clean: Record<string, string | undefined> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if ((INHERITED as readonly string[]).includes(k)) ignored.push(k);
    else clean[k] = v;
  }
  return { clean, ignored };
}

/** A warning can quote a key from a repo's settings file; terminal escapes in it would let the file rewrite what the user reads. */
export function printable(text: string): string {
  return text.replaceAll(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u{${c.codePointAt(0)?.toString(16)}}`,
  );
}

export async function ensureDataDir(dataDir: string): Promise<{ writable: boolean; notice?: string }> {
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (isErrno(err, "EACCES", "EROFS", "EPERM", "EEXIST", "ENOTDIR")) {
      return { writable: false, notice: `Dovet data directory ${dataDir} is not writable; sessions won't be saved.` };
    }
    throw err;
  }
  const probe = join(dataDir, `.writable-${crypto.randomUUID()}`);
  try {
    await writeFile(probe, "ok", { mode: 0o600 });
    await rm(probe, { force: true }).catch(() => undefined);
    return { writable: true };
  } catch (err) {
    if (isErrno(err, "EACCES", "EROFS", "EPERM", "EEXIST", "ENOTDIR")) {
      return { writable: false, notice: `Dovet data directory ${dataDir} is not writable; sessions won't be saved.` };
    }
    throw err;
  }
}

const TrustedFolders = z.record(z.string(), z.object({ hash: z.string(), trusted: z.boolean() }));

export async function loadTrustedFolders(
  dataDir: string,
  nowMs: number,
): Promise<{ trusted: Record<string, { hash: string; trusted: boolean }>; warning?: string; backedUp?: string }> {
  const path = join(dataDir, "trusted-folders.json");
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return { trusted: {} };
    throw err;
  }
  const parsed = (() => {
    try {
      return TrustedFolders.safeParse(JSON.parse(text ?? ""));
    } catch {
      return { success: false as const, error: undefined };
    }
  })();
  if (parsed.success) return { trusted: parsed.data };
  const stamp = new Date(nowMs).toISOString().replaceAll(/[:.]/g, "-");
  const backup = `${path}.corrupt-${stamp}`;
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch {
    // Keep the original file when the directory itself is not writable.
  }
  await rename(path, backup);
  await writeFile(path, "{}\n", { mode: 0o600 });
  return {
    trusted: {},
    warning: `trusted-folders.json was corrupt; backed up to ${backup} and rebuilt.`,
    backedUp: backup,
  };
}

export function offlineRefusal(tool: "WebFetch" | "WebSearch"): string {
  return `${tool} is disabled in --offline mode; only model requests leave the machine.`;
}
