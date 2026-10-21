// M0 exit evidence: the compiled binary takes and restores a filter-safe snapshot (checkpoints "Git tree snapshots").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { compileDovet } from "../../../scripts/build.ts";

const EXE = process.platform === "win32" ? ".exe" : "";
const slash = (p: string): string => p.replaceAll("\\", "/");

interface ProbeOut {
  trees: [string, string];
  edited: { a: string | null; keep: string | null; created: string | null };
  restored: {
    result: { written: number; deleted: number; skipped: unknown[]; failed: string[] };
    a: string | null;
    b: string | null;
    keep: string | null;
    created: string | null;
    madeDirExists: boolean;
  };
}

let dir = "";
let repo = "";
let tools = "";
let gitBefore = new Map<string, string>();
let gitAfter = new Map<string, string>();
let out: ProbeOut;
let connections = 0;
const FILTER_MARKERS = ["local-clean", "local-smudge", "local-process", "local-fsmonitor", "global-clean"];
let ranDuringProbe: string[] = [];
let connectionsDuringProbe = -1;
let port = 0;
let stopServer = (): void => {};

function envFor(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  return env;
}

/** Every file and directory under `.git` with its bytes (hex) and modification time. */
function dump(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        result.set(`${relative(root, p)}/`, `dir@${statSync(p).mtimeMs}`);
        walk(p);
      } else result.set(relative(root, p), `${readFileSync(p).toString("hex")}@${statSync(p).mtimeMs}`);
    }
  };
  walk(root);
  return result;
}

function git(cwd: string, home: string, ...args: string[]): void {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: envFor(home) },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

beforeAll(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "dovet-snap-probe-")));
  repo = join(dir, "work tree");
  tools = join(dir, "tools");
  const home = join(dir, "home");
  const project = join(dir, "dovet-data", "projects", "p1");
  for (const d of [repo, tools, home, join(repo, "src")]) mkdirSync(d, { recursive: true });

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        connections++;
      },
      data() {},
    },
  });
  port = server.port;
  stopServer = () => server.stop(true);
  const script = join(tools, "filter.js");
  writeFileSync(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      'import { connect } from "node:net";',
      "writeFileSync(process.argv[2], 'ran');",
      "const socket = connect(Number(process.argv[3]), '127.0.0.1');",
      "socket.on('error', () => process.exit(0));",
      "socket.on('connect', () => { socket.end(); process.exit(0); });",
      "process.stdin.resume();",
      "setTimeout(() => process.exit(0), 3000);",
      "",
    ].join("\n"),
  );
  const command = (name: string): string =>
    `"${slash(process.execPath)}" "${slash(script)}" "${slash(join(tools, name))}" ${port}`;

  git(repo, home, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.dat"), "b\n");
  writeFileSync(join(repo, "src", "keep.txt"), "kept\n");
  writeFileSync(join(repo, "notes.md"), "notes\n");
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=cleaner\n*.dat filter=proc\n*.md filter=globalonly\n");
  git(repo, home, "add", "-A");
  git(repo, home, "commit", "-q", "-m", "init");
  git(repo, home, "config", "filter.cleaner.clean", command("local-clean"));
  git(repo, home, "config", "filter.cleaner.smudge", command("local-smudge"));
  git(repo, home, "config", "filter.proc.process", command("local-process"));
  git(repo, home, "config", "core.fsmonitor", command("local-fsmonitor"));
  const quoted = command("global-clean").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  writeFileSync(join(home, ".gitconfig"), `[filter "globalonly"]\n\tclean = "${quoted}"\n`);

  const probe = join(dir, `probe${EXE}`);
  await compileDovet({ entry: join(import.meta.dir, "snapshot-probe.ts"), outfile: probe });

  gitBefore = dump(join(repo, ".git"));
  const r = Bun.spawnSync([probe, repo, project], { cwd: dir, env: envFor(home) });
  if (r.exitCode !== 0) throw new Error(`probe failed (${r.exitCode}): ${r.stderr.toString()}`);
  gitAfter = dump(join(repo, ".git"));
  out = JSON.parse(r.stdout.toString()) as ProbeOut;
  await Bun.sleep(500); // a filter that had been started would have written its marker by now
  ranDuringProbe = FILTER_MARKERS.filter((name) => existsSync(join(tools, name)));
  connectionsDuringProbe = connections;

  // Control: plain git does run these filters here, so the checks above cannot pass vacuously on this OS.
  for (const file of ["a.txt", "notes.md"]) {
    Bun.spawnSync(["git", "hash-object", `--path=${file}`, file], { cwd: repo, env: envFor(home) });
  }
  await Bun.sleep(500);
}, 180_000);

afterAll(() => {
  stopServer();
  // Windows may still hold the just-run executable open for a moment.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("compiled binary takes and restores a filter-safe snapshot", () => {
  test("two snapshots of different states give different tree ids", () => {
    expect(out.trees[0]).toMatch(/^[0-9a-f]{40,64}$/);
    expect(out.trees[1]).toMatch(/^[0-9a-f]{40,64}$/);
    expect(out.trees[0]).not.toBe(out.trees[1]);
  });

  test("the probe really changed the workspace before restoring", () => {
    expect(out.edited).toEqual({ a: "edited by the agent\n", keep: null, created: "brand new\n" });
  });

  test("restore brings back edited and deleted files and removes files created since", () => {
    expect(out.restored.a).toBe("a\n");
    expect(out.restored.b).toBe("b\n");
    expect(out.restored.keep).toBe("kept\n");
    expect(out.restored.created).toBeNull();
    expect(out.restored.madeDirExists).toBe(false);
    expect(out.restored.result).toEqual({ written: 3, deleted: 1, skipped: [], failed: [] });
  });

  test("the user's .git is byte-identical, timestamps included, after snapshots and a restore", () => {
    expect(gitAfter.size).toBe(gitBefore.size);
    expect([...gitAfter]).toEqual([...gitBefore]);
  });

  test("no configured filter, fsmonitor or process filter ran, and nothing opened a connection", () => {
    expect(ranDuringProbe).toEqual([]);
    expect(connectionsDuringProbe).toBe(0);
  });

  test("control: git hash-object runs the local and the global clean filter on this machine", () => {
    for (const name of ["local-clean", "global-clean"]) expect(existsSync(join(tools, name))).toBe(true);
    expect(connections).toBeGreaterThan(0);
  });
});
