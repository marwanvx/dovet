import { mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { applyEdits, findNodeAtLocation, modify } from "jsonc-parser";
import { isErrno } from "../../platform/index.ts";
import { SettingsError } from "./errors.ts";
import type { RuleKind } from "./merge.ts";
import { nodeValue, parseSettingsText } from "./parse.ts";
import { readSettingsText } from "./read.ts";

const LOCAL_FILE = join(".dovet", "settings.local.json");

/** Temp file plus rename; a symlinked file is replaced at its target and the link is kept. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  let target = path;
  try {
    target = await realpath(path);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    target = await readlink(path).then(
      (link) => resolve(dirname(path), link),
      (e: unknown) => (isErrno(e, "ENOENT", "EINVAL") ? path : Promise.reject(e)),
    );
  }
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    (err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)),
  );
  const temp = join(dirname(target), `.${basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, data, mode === undefined ? undefined : { mode });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

async function addToArray(file: string, path: string[], items: string[]): Promise<void> {
  const existing = await readSettingsText(file);
  const created = existing === undefined;
  let text = existing ?? "{}\n";
  const { tree } = parseSettingsText(text, file);
  const node = tree && findNodeAtLocation(tree, path);
  const current = node === undefined ? undefined : nodeValue(node);
  if (current !== undefined && !Array.isArray(current)) {
    throw new SettingsError([{ file, key: path.join("."), message: "is not a list, so a rule can't be added to it" }]);
  }
  const have = new Set(current ?? []);
  const missing = [...new Set(items)].filter((i) => !have.has(i));
  if (missing.length === 0 && !created) return;
  const fmt = { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  if (current === undefined) {
    text = applyEdits(text, modify(text, path, missing, { formattingOptions: fmt }));
  } else {
    missing.forEach((item, i) => {
      text = applyEdits(
        text,
        modify(text, [...path, current.length + i], item, { formattingOptions: fmt, isArrayInsertion: true }),
      );
    });
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, text);
}

const missing = (err: unknown): undefined => {
  if (isErrno(err, "ENOENT", "ENOTDIR")) return undefined;
  throw err;
};

/** `<repo>/.git/info`, or the shared one when `.git` is a worktree's pointer file. */
async function gitInfoDir(projectRoot: string): Promise<string | undefined> {
  const dotGit = join(projectRoot, ".git");
  const info = await stat(dotGit).catch(missing);
  if (info === undefined) return undefined;
  if (info.isDirectory()) return join(dotGit, "info");
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
  if (pointer?.[1] === undefined) return undefined;
  const gitDir = resolve(projectRoot, pointer[1].trim());
  const common = await readFile(join(gitDir, "commondir"), "utf8").catch(missing);
  return join(common === undefined ? gitDir : resolve(gitDir, common.trim()), "info");
}

async function excludeFromGit(projectRoot: string): Promise<void> {
  const infoDir = await gitInfoDir(projectRoot);
  if (infoDir === undefined) return;
  const entry = `/${LOCAL_FILE.replaceAll("\\", "/")}`;
  const file = join(infoDir, "exclude");
  const current = (await readFile(file, "utf8").catch(missing)) ?? "";
  if (current.split(/\r?\n/).includes(entry)) return;
  await mkdir(infoDir, { recursive: true });
  await writeFile(file, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${entry}\n`);
}

/** "Don't ask again": the rule goes to `<project>/.dovet/settings.local.json`, never into Claude Code's files. */
export async function saveLocalRule(projectRoot: string, kind: RuleKind, rule: string): Promise<void> {
  await addToArray(join(projectRoot, LOCAL_FILE), ["permissions", kind], [rule]);
  await excludeFromGit(projectRoot);
}
