// SPIKE-22 benchmark: how long git tree snapshots take on a large repository (default 100,000 files).
// Usage: bun scripts/bench-snapshots.ts [fileCount]
// Prints a Markdown table; in CI it also goes to the job summary.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSnapshotter } from "../src/store/index.ts";

const count = Number(Bun.argv[2] ?? 100_000);
const perDir = 100;
const root = realpathSync.native(mkdtempSync(join(Bun.argv[3] ?? tmpdir(), "dovet-bench-")));
const repo = join(root, "repo");
const env: Record<string, string | undefined> = {
  ...process.env,
  HOME: join(root, "home"),
  USERPROFILE: join(root, "home"),
};
mkdirSync(env.HOME ?? root, { recursive: true });

function git(...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=bench", "-c", "user.email=bench@example.com", ...args], {
    cwd: repo,
    env,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

const started = performance.now();
/** Progress lines with elapsed seconds, so a run that hits the CI time limit still shows how far it got. */
function log(message: string): void {
  console.log(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${message}`);
}

async function time<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await run();
  return { ms: Math.round(performance.now() - t0), value };
}

try {
  mkdirSync(repo, { recursive: true });
  git("init", "-q");
  const past = new Date(Date.now() - 3_600_000);
  for (let d = 0; d * perDir < count; d++) {
    const dir = join(repo, "src", `d${d}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < perDir && d * perDir + i < count; i++) {
      writeFileSync(join(dir, `f${i}.ts`), `export const v${d}_${i} = ${d * perDir + i};\n`.repeat(20));
    }
  }
  log(`${count} files written`);
  git("add", "-A");
  log("git add done");
  git("commit", "-q", "-m", "bench");
  log("committed");
  const files: string[] = [];
  for (let d = 0; d * perDir < count; d++)
    for (let i = 0; i < perDir && d * perDir + i < count; i++) files.push(join(repo, "src", `d${d}`, `f${i}.ts`));
  for (const f of files) utimesSync(f, past, past);
  log("timestamps aged; measuring");

  const sourceBytes = dirBytes(join(repo, "src"));
  const snap = await openSnapshotter({
    workspace: repo,
    projectDir: join(root, "data", "p1"),
    session: "bench",
    env,
    platform: process.platform,
  });
  const first = await time(() => snap.snapshot());
  log(`first snapshot ${first.ms} ms`);
  const second = await time(() => snap.snapshot());
  log(`second snapshot ${second.ms} ms`);
  for (const f of files.slice(0, 100)) writeFileSync(f, "changed\n");
  const edited = await time(() => snap.snapshot());
  log(`edited snapshot ${edited.ms} ms`);
  const status = await time(async () => git("status", "--porcelain"));

  const phases = [
    ["first", first.value.timings],
    ["second", second.value.timings],
    ["edited", edited.value.timings],
  ] as const;
  const rows = [
    ["first snapshot (everything hashed)", first.ms, first.value.hashed],
    ["second snapshot, nothing changed", second.ms, second.value.hashed],
    ["after editing 100 files", edited.ms, edited.value.hashed],
    ["`git status` for comparison", status.ms, "-"],
  ];
  const table = [
    `### Git tree snapshots, ${count} files, ${process.platform} ${process.arch}, Bun ${Bun.version}`,
    "",
    "| step | ms | files hashed |",
    "|---|---:|---:|",
    ...rows.map(([name, ms, hashed]) => `| ${name} | ${ms} | ${hashed} |`),
    "",
    "| snapshot | list files | lstat + cache | hash | index + write-tree | total (ms) |",
    "|---|---:|---:|---:|---:|---:|",
    ...phases.map(([name, t]) => `| ${name} | ${t.list} | ${t.stat} | ${t.hash} | ${t.index} | ${t.total} |`),
    "",
    `Private object store after the three snapshots: ${(dirBytes(join(root, "data", "p1", "objects")) / 1e6).toFixed(1)} MB, for ${(sourceBytes / 1e6).toFixed(1)} MB of source files.`,
    "",
  ].join("\n");
  console.log(table);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${table}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
