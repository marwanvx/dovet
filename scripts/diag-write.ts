// Throwaway diagnostic: cost of writing new git objects, by method. Usage: bun scripts/diag-write.ts <baseDir> [count]
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const base = Bun.argv[2];
const count = Number(Bun.argv[3] ?? 5000);
if (!base) throw new Error("usage: diag-write.ts <baseDir> [count]");
const root = mkdtempSync(join(base, "dw-"));
const work = join(root, "work");
mkdirSync(work);
const paths: string[] = [];
for (let d = 0; d * 100 < count; d++) {
  mkdirSync(join(work, `d${d}`));
  for (let i = 0; i < 100 && d * 100 + i < count; i++) {
    const p = join(work, `d${d}`, `f${i}.ts`);
    writeFileSync(p, `export const v${d}_${i} = ${d * 100 + i};\n`.repeat(20));
    paths.push(p);
  }
}
Bun.spawnSync(["git", "init", "-q"], { cwd: work });
const rows: string[] = [];
function dirCount(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirCount(join(dir, e.name)) : 1;
  return n;
}
function variant(name: string, run: (objects: string) => void): void {
  const objects = join(root, `objects-${rows.length}`);
  mkdirSync(objects);
  const t0 = performance.now();
  run(objects);
  const ms = performance.now() - t0;
  rows.push(`| ${name} | ${ms.toFixed(0)} | ${((ms * 1000) / count).toFixed(0)} | ${dirCount(objects)} |`);
}
const input = new TextEncoder().encode(`${paths.join("\n")}\n`);
function hashObject(extra: string[]): (objects: string) => void {
  return (objects) => {
    const r = Bun.spawnSync(["git", ...extra, "hash-object", "--no-filters", "-w", "--stdin-paths"], {
      cwd: work,
      env: { ...process.env, GIT_OBJECT_DIRECTORY: objects },
      stdin: input,
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
}
variant("hash-object -w (default)", hashObject([]));
variant("hash-object -w, core.fsync=none", hashObject(["-c", "core.fsync=none"]));
variant("hash-object -w, core.looseCompression=0", hashObject(["-c", "core.looseCompression=0"]));
variant("hash-object -w, fsync=none + looseCompression=0", hashObject(["-c", "core.fsync=none", "-c", "core.looseCompression=0"]));
variant("fast-import (one pack)", (objects) => {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const p of paths) {
    const bytes = new Uint8Array(require("node:fs").readFileSync(p));
    parts.push(enc.encode(`blob\ndata ${bytes.length}\n`), bytes, enc.encode("\n"));
  }
  const r = Bun.spawnSync(["git", "fast-import", "--quiet"], {
    cwd: work,
    env: { ...process.env, GIT_OBJECT_DIRECTORY: objects },
    stdin: new Blob(parts as BlobPart[]),
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
});
variant("hash-object -w again (objects already exist in a new dir? no: fresh dir)", hashObject([]));
const mb = (statSync(paths[0] ?? work).size * count) / 1e6;
console.log(`#### ${process.platform} ${base} (${count} files, ${mb.toFixed(1)} MB)\n\n| method | total ms | µs per file | files in object dir |\n|---|---:|---:|---:|\n${rows.join("\n")}\n`);
rmSync(root, { recursive: true, force: true });
