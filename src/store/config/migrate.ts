import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";
import { nodeValue } from "./parse.ts";

export type Change =
  | { kind: "rename"; from: string; to: string; value?: (old: unknown) => unknown }
  | { kind: "remove"; path: string; reason: string };
export type Migration = { to: number; changes: Change[] };
export type PendingMigration = { file: string; changes: string[] };

/** Releases that rename or remove a key append a step here (cli-config "Settings migration"). */
export const MIGRATIONS: Migration[] = [];

const SETTINGS_VERSION_WITHOUT_FIELD = 1;

export function fileVersion(value: unknown): number {
  const version = typeof value === "object" && value !== null ? (value as { $version?: unknown }).$version : undefined;
  return typeof version === "number" ? version : SETTINGS_VERSION_WITHOUT_FIELD;
}

/** Applies the steps newer than `from` with comment-preserving edits; `changes` is empty when nothing in the file needed one. */
export function migrateText(
  text: string,
  from: number,
  migrations: readonly Migration[],
): { text: string; changes: string[] } {
  const pending = migrations.filter((m) => m.to > from).sort((a, b) => a.to - b.to);
  const fmt = { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  const changes: string[] = [];
  let current = text;
  const valueAt = (path: string[]): { found: boolean; value?: unknown } => {
    const tree = parseTree(current, [], { allowTrailingComma: true });
    const node = tree && findNodeAtLocation(tree, path);
    return node === undefined ? { found: false } : { found: true, value: nodeValue(node) };
  };
  const set = (path: string[], value: unknown) => {
    current = applyEdits(current, modify(current, path, value, { formattingOptions: fmt }));
  };

  for (const migration of pending) {
    for (const change of migration.changes) {
      const source = valueAt((change.kind === "rename" ? change.from : change.path).split("."));
      if (!source.found) continue;
      if (change.kind === "remove") {
        set(change.path.split("."), undefined);
        changes.push(`\`${change.path}\` was removed: ${change.reason}`);
        continue;
      }
      const mapped = change.value ? change.value(source.value) : source.value;
      const target = change.to.split(".");
      if (!valueAt(target).found) set(target, mapped);
      set(change.from.split("."), undefined);
      changes.push(`\`${change.from}\` → \`${change.to}${change.value ? `: ${JSON.stringify(mapped)}` : ""}\``);
    }
  }
  if (changes.length > 0) set(["$version"], pending[pending.length - 1]?.to);
  return { text: current, changes };
}
