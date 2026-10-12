// Dovet's own per-session stat cache: `path → size, mtimeNs, inode, mode, blob id` (checkpoints "Git tree snapshots").
// A file whose stat matches is not re-read. Stored as text; a missing, old or damaged file is an empty cache, which
// only costs one full re-hash.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const HEADER = "dovet-snap-stat 1";

export interface CacheEntry {
  readonly mode: string;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ino: bigint;
  readonly blob: string;
}

export type StatCache = Map<string, CacheEntry>;

const LINE = /^(100644|100755|120000)\t(\d+)\t(\d+)\t(\d+)\t([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/;

export function loadStatCache(file: string): StatCache {
  const cache: StatCache = new Map();
  if (!existsSync(file)) return cache;
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines[0] !== HEADER) return new Map();
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const m = LINE.exec(line);
    if (!m) return new Map();
    const [, mode, size, mtimeNs, ino, blob, path] = m;
    if (mode === undefined || size === undefined || mtimeNs === undefined || ino === undefined) return new Map();
    if (blob === undefined || path === undefined) return new Map();
    cache.set(path, { mode, size: BigInt(size), mtimeNs: BigInt(mtimeNs), ino: BigInt(ino), blob });
  }
  return cache;
}

/** Writes the cache atomically (temp file, then rename). */
export function saveStatCache(file: string, cache: StatCache): void {
  const lines = [HEADER];
  for (const [path, e] of cache) lines.push(`${e.mode}\t${e.size}\t${e.mtimeNs}\t${e.ino}\t${e.blob}\t${path}`);
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  writeFileSync(tmp, `${lines.join("\n")}\n`);
  renameSync(tmp, file);
}
