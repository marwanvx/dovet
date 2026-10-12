// Throwaway diagnostic: where does time go on a CI filesystem? Usage: bun scripts/diag-fs.ts <baseDir> [fileCount]
import { lstatSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = Bun.argv[2];
const count = Number(Bun.argv[3] ?? 5000);
if (!base) throw new Error("usage: diag-fs.ts <baseDir> [count]");
const dir = join(base, `diag-${crypto.randomUUID().slice(0, 8)}`);
const rows: string[] = [];
function t<T>(name: string, run: () => T): T {
  const t0 = performance.now();
  const v = run();
  const ms = performance.now() - t0;
  rows.push(`| ${name} | ${ms.toFixed(0)} | ${((ms * 1000) / count).toFixed(0)} |`);
  return v;
}
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=d", "-c", "user.email=d@e.x", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

mkdirSync(dir, { recursive: true });
const paths: string[] = [];
for (let d = 0; d * 100 < count; d++) {
  mkdirSync(join(dir, `d${d}`), { recursive: true });
  for (let i = 0; i < 100 && d * 100 + i < count; i++) paths.push(join(dir, `d${d}`, `f${i}.ts`));
}
const body = "export const x = 1;\n".repeat(20);
t("write files (Bun/node fs)", () => { for (const p of paths) writeFileSync(p, body); });
t("lstat (bigint)", () => { for (const p of paths) lstatSync(p, { bigint: true }); });
t("lstat (plain)", () => { for (const p of paths) lstatSync(p); });
t("read files", () => { for (const p of paths) readFileSync(p); });
const past = new Date(Date.now() - 3_600_000);
t("utimes", () => { for (const p of paths) utimesSync(p, past, past); });
t("spawn `git --version` x100 (per-op = per spawn x count/100)", () => { for (let i = 0; i < 100; i++) Bun.spawnSync(["git", "--version"]); });
git(dir, "init", "-q");
t("git add -A", () => git(dir, "add", "-A"));
t("git commit", () => git(dir, "commit", "-q", "-m", "x"));
t("git ls-files --cached", () => git(dir, "ls-files", "-z", "--cached"));
t("git ls-files --others (nothing untracked)", () => git(dir, "ls-files", "-z", "--others", "--exclude-standard"));
t("git status", () => git(dir, "status", "--porcelain"));
t("git -c core.fsmonitor=false -c core.untrackedCache=true status", () => git(dir, "-c", "core.untrackedCache=true", "status", "--porcelain"));
const list = paths.map((p) => p).join("\n") + "\n";
t("git hash-object --stdin-paths (no -w)", () => {
  const r = Bun.spawnSync(["git", "hash-object", "--no-filters", "--stdin-paths"], { cwd: dir, stdin: new TextEncoder().encode(list) });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
});
t("git hash-object -w --stdin-paths", () => {
  const r = Bun.spawnSync(["git", "hash-object", "--no-filters", "-w", "--stdin-paths"], { cwd: dir, stdin: new TextEncoder().encode(list) });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
});
console.log(`#### ${process.platform} ${base} (${count} files)\n\n| step | total ms | µs per file |\n|---|---:|---:|\n${rows.join("\n")}\n`);
rmSync(dir, { recursive: true, force: true });
