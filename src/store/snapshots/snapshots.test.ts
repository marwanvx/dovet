// Git tree snapshots (docs/specs/checkpoints.md "Git tree snapshots"), tested with real git repositories and real
// processes in temp directories: nothing is mocked, because the point is what git does to the user's `.git`.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openSnapshotter, type Snapshotter } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), `dovet-snap-${label}-`)));
  dirs.push(d);
  return d;
}

/** The environment a session would hand over: PATH and friends, with HOME pointing at a throwaway home. */
function baseEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  return env;
}

function git(cwd: string, home: string, ...args: string[]): string {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: baseEnv(home) },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** An old mtime on everything, so the racy-timestamp guard doesn't hide the stat cache from the tests. */
function age(dir: string): void {
  const past = new Date(Date.now() - 3_600_000);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) age(p);
    else if (!entry.isSymbolicLink()) utimesSync(p, past, past);
  }
}

interface Fixture {
  repo: string;
  home: string;
  project: string;
  open: (session?: string, env?: Record<string, string | undefined>) => Promise<Snapshotter>;
  git: (...args: string[]) => string;
}

function fixture(files: Record<string, string | Uint8Array>, commit = true): Fixture {
  const root = tempDir("repo");
  const repo = join(root, "work tree");
  const home = join(root, "home");
  const project = join(root, "dovet-data", "projects", "p1");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const run = (...args: string[]): string => git(repo, home, ...args);
  run("init", "-q", "-b", "main");
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), data);
  }
  if (commit) {
    run("add", "-A");
    run("commit", "-q", "-m", "init");
  }
  age(repo);
  return {
    repo,
    home,
    project,
    git: run,
    open: (session = "s1", env = baseEnv(home)) =>
      openSnapshotter({ workspace: repo, projectDir: project, session, env, platform: process.platform }),
  };
}

/** `git ls-tree` against the private object store, which is where a snapshot's tree lives. */
function lsTree(f: Fixture, tree: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "ls-tree", tree, ...args], {
    cwd: f.repo,
    env: { ...baseEnv(f.home), GIT_OBJECT_DIRECTORY: join(f.project, "objects") },
  });
  if (r.exitCode !== 0) throw new Error(`git ls-tree failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** Every file and directory under `dir` with its bytes (hex) and modification time, so two states compare exactly. */
function dump(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        out.set(`${relative(dir, p)}/`, `dir@${statSync(p).mtimeMs}`);
        walk(p);
      } else out.set(relative(dir, p), `${Buffer.from(readFileSync(p)).toString("hex")}@${statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

describe("snapshot", () => {
  test("a clean checkout snapshots to exactly the commit's tree", async () => {
    const f = fixture({ "a.txt": "one\n", "src/b.ts": "export const b = 2;\n", "src/deep/c.md": "# c\n" });
    const snap = await f.open();
    const { tree } = await snap.snapshot();
    expect(tree).toBe(f.git("rev-parse", "HEAD^{tree}").trim());
  });

  test("untracked files are included, ignored files and .git are not", async () => {
    const f = fixture({ ".gitignore": "build/\n", "a.txt": "a\n" });
    writeFileSync(join(f.repo, "new.txt"), "new\n");
    mkdirSync(join(f.repo, "build"));
    writeFileSync(join(f.repo, "build", "out.js"), "x\n");
    const snap = await f.open();
    const { tree } = await snap.snapshot();
    const names = new Set(lsTree(f, tree, "-r", "--name-only").split("\n").filter(Boolean));
    expect(names).toEqual(new Set([".gitignore", "a.txt", "new.txt"]));
  });

  test("a second snapshot rehashes only the files that changed", async () => {
    const f = fixture({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    const snap = await f.open();
    const first = await snap.snapshot();
    expect(first.hashed).toBe(3);
    const second = await snap.snapshot();
    expect(second.hashed).toBe(0);
    expect(second.tree).toBe(first.tree);
    writeFileSync(join(f.repo, "b.txt"), "changed\n");
    const third = await snap.snapshot();
    expect(third.hashed).toBe(1);
    expect(third.tree).not.toBe(first.tree);
  });

  test("a new session starts from the previous session's stat cache but keeps its own index", async () => {
    const f = fixture({ "a.txt": "a\n", "b.txt": "b\n" });
    const first = await (await f.open("s1")).snapshot();
    expect((await (await f.open("s1")).snapshot()).hashed).toBe(0);
    writeFileSync(join(f.repo, "b.txt"), "changed\n");
    const second = await (await f.open("s2")).snapshot();
    expect(second.hashed).toBe(1); // only what changed since s1
    expect(second.tree).not.toBe(first.tree);
    expect(existsSync(join(f.project, "sessions", "s1.snap.index"))).toBe(true);
    expect(existsSync(join(f.project, "sessions", "s2.snap.index"))).toBe(true);
  });

  test("a file modified just now is never trusted from the cache, because timestamps are coarse", async () => {
    const f = fixture({ "a.txt": "aaaa\n" });
    const snap = await f.open();
    writeFileSync(join(f.repo, "a.txt"), "bbbb\n"); // mtime is now
    const first = await snap.snapshot();
    const second = await snap.snapshot();
    expect(first.hashed).toBe(1);
    expect(second.hashed).toBe(1);
    expect(second.tree).toBe(first.tree);
  });

  test("untracked files over 2 MiB are left out and reported, tracked ones of any size stay", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(97);
    const f = fixture({ "tracked-big.bin": big, "a.txt": "a\n" });
    writeFileSync(join(f.repo, "untracked-big.bin"), big);
    writeFileSync(join(f.repo, "small.txt"), "s\n");
    age(f.repo);
    const snap = await f.open();
    const { tree, skipped } = await snap.snapshot();
    expect(skipped).toEqual([{ path: "untracked-big.bin", reason: "too-large" }]);
    expect(f.git("rev-parse", "HEAD^{tree}").trim()).not.toBe(tree);
    const restored = await snap.restore(tree, skipped);
    expect(restored.written).toBe(0);
  });

  test("tracked files over 50 MB are left out too", async () => {
    const huge = new Uint8Array(51_000_000);
    const f = fixture({ "huge.bin": huge, "a.txt": "a\n" });
    const { skipped } = await (await f.open()).snapshot();
    expect(skipped).toEqual([{ path: "huge.bin", reason: "too-large" }]);
  }, 60_000);

  test("a nested repository is untracked content of its parent: its files are in, its .git and ignored files are not", async () => {
    const f = fixture({ "a.txt": "a\n" });
    const nested = join(f.repo, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    git(nested, f.home, "init", "-q");
    writeFileSync(join(nested, ".gitignore"), "*.log\n");
    writeFileSync(join(nested, "x.txt"), "x\n");
    writeFileSync(join(nested, "debug.log"), "noise\n");
    const snap = await f.open();
    const { tree, skipped } = await snap.snapshot();
    expect(skipped).toEqual([]);
    const names = new Set(lsTree(f, tree, "-r", "--name-only").split("\n").filter(Boolean));
    expect(names).toEqual(new Set(["a.txt", "vendor/lib/.gitignore", "vendor/lib/x.txt"]));
  });

  test("a submodule is recorded as a gitlink and reported as not restorable", async () => {
    const f = fixture({ "a.txt": "a\n" });
    const sub = join(f.repo, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "s.txt"), "s\n");
    git(sub, f.home, "init", "-q");
    git(sub, f.home, "add", "-A");
    git(sub, f.home, "commit", "-q", "-m", "sub");
    const subHead = git(sub, f.home, "rev-parse", "HEAD").trim();
    f.git("add", "sub"); // a repository inside the work tree with a commit becomes a gitlink
    const snap = await f.open();
    const { tree, skipped } = await snap.snapshot();
    expect(skipped).toEqual([{ path: "sub", reason: "gitlink" }]);
    expect(lsTree(f, tree, "sub")).toStartWith(`160000 commit ${subHead}`);
    expect((await snap.restore(tree, skipped)).skipped).toEqual([]);
  });

  test("a symlink is recorded as a link, never followed", async () => {
    const f = fixture({ "target.txt": "secret\n" });
    symlinkSync("target.txt", join(f.repo, "link"));
    const snap = await f.open();
    const { tree } = await snap.snapshot();
    const entry = lsTree(f, tree, "link");
    expect(entry).toStartWith("120000 blob ");
  });

  test("works from a linked worktree, where .git is a file", async () => {
    const f = fixture({ "a.txt": "a\n" });
    const linked = join(f.repo, "..", "linked");
    // Git for Windows checks out CRLF by default; snapshots store the bytes on disk, so keep this about worktrees.
    f.git("config", "core.autocrlf", "false");
    f.git("worktree", "add", "-q", linked, "-b", "side");
    age(linked);
    const snap = await openSnapshotter({
      workspace: linked,
      projectDir: join(f.project, "wt"),
      session: "s1",
      env: baseEnv(f.home),
      platform: process.platform,
    });
    const { tree } = await snap.snapshot();
    expect(tree).toBe(f.git("rev-parse", "HEAD^{tree}").trim());
    writeFileSync(join(linked, "a.txt"), "edited\n");
    await snap.restore(tree, []);
    expect(readFileSync(join(linked, "a.txt"), "utf8")).toBe("a\n");
  });
});

describe("restore", () => {
  test("rewinds an edit, a deletion and a new file", async () => {
    const f = fixture({ "keep.txt": "keep\n", "edit.txt": "before\n", "gone.txt": "bye\n", "dir/x.txt": "x\n" });
    const snap = await f.open();
    const { tree } = await snap.snapshot();

    writeFileSync(join(f.repo, "edit.txt"), "after, longer\n");
    rmSync(join(f.repo, "gone.txt"));
    rmSync(join(f.repo, "dir", "x.txt"));
    mkdirSync(join(f.repo, "fresh"), { recursive: true });
    writeFileSync(join(f.repo, "fresh", "new.txt"), "new\n");

    const result = await snap.restore(tree, []);
    expect(result).toMatchObject({ written: 3, deleted: 1, skipped: [] });
    expect(readFileSync(join(f.repo, "edit.txt"), "utf8")).toBe("before\n");
    expect(readFileSync(join(f.repo, "gone.txt"), "utf8")).toBe("bye\n");
    expect(readFileSync(join(f.repo, "dir", "x.txt"), "utf8")).toBe("x\n");
    expect(existsSync(join(f.repo, "fresh"))).toBe(false); // the directory it emptied goes too
    expect(readFileSync(join(f.repo, "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("a file that existed at the checkpoint but was left out of it is not deleted", async () => {
    const f = fixture({ "a.txt": "a\n" });
    const log = join(f.repo, "big.log");
    writeFileSync(log, new Uint8Array(3 * 1024 * 1024));
    age(f.repo);
    const snap = await f.open();
    const { tree, skipped } = await snap.snapshot();
    expect(skipped).toEqual([{ path: "big.log", reason: "too-large" }]);
    writeFileSync(log, "now small\n"); // the next snapshot sees it as a new, small file
    const result = await snap.restore(tree, skipped);
    expect(result.deleted).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("now small\n");
  });

  test("an existing file keeps its permissions, a restored one does not become world-readable", async () => {
    const f = fixture({ "secret.env": "k=1\n" });
    if (process.platform === "win32") return;
    chmodSync(join(f.repo, "secret.env"), 0o600);
    const snap = await f.open();
    const { tree } = await snap.snapshot();
    writeFileSync(join(f.repo, "secret.env"), "k=2\n");
    await snap.restore(tree, []);
    expect(readFileSync(join(f.repo, "secret.env"), "utf8")).toBe("k=1\n");
    expect(statSync(join(f.repo, "secret.env")).mode & 0o777).toBe(0o600);
  });

  test("never writes through a hard link", async () => {
    const f = fixture({ "a.txt": "a\n" });
    const other = join(tempDir("links"), "other.txt");
    linkSync(join(f.repo, "a.txt"), other);
    const snap = await f.open();
    const { tree } = await snap.snapshot();
    writeFileSync(join(f.repo, "a.txt"), "edited through the link\n");
    const result = await snap.restore(tree, []);
    expect(result.skipped).toEqual([{ path: "a.txt", reason: "link" }]);
  });

  test("rejects anything that is not an object id", async () => {
    const f = fixture({ "a.txt": "a\n" });
    const snap = await f.open();
    const out = join(tempDir("out"), "created-by-an-option");
    await expect(snap.restore(`--output=${out}`, [])).rejects.toThrow("not a tree id");
    expect(existsSync(out)).toBe(false);
  });

  test("refuses a tree that names .git or ..", async () => {
    const f = fixture({ "a.txt": "a\n" });
    const snap = await f.open();
    await snap.snapshot();
    const env = { ...baseEnv(f.home), GIT_OBJECT_DIRECTORY: join(f.project, "objects") };
    const hash = (type: string, input: Uint8Array): string => {
      const r = Bun.spawnSync(["git", "hash-object", "-t", type, "-w", "--literally", "--stdin"], {
        cwd: f.repo,
        env,
        stdin: input,
      });
      return r.stdout.toString().trim();
    };
    const blob = hash("blob", new TextEncoder().encode("planted\n"));
    for (const name of [".git", ".GIT", ".."]) {
      const entry = Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob, "hex")]);
      const tree = hash("tree", entry);
      await expect(snap.restore(tree, [])).rejects.toThrow("refusing to restore");
    }
    expect(existsSync(join(f.repo, ".git", "planted"))).toBe(false);
  });

  test("never writes through a link that took a tracked file's place", async () => {
    const f = fixture({ "a.txt": "a\n" });
    const outside = join(tempDir("outside"), "victim.txt");
    writeFileSync(outside, "untouched\n");
    const snap = await f.open();
    const { tree } = await snap.snapshot();
    rmSync(join(f.repo, "a.txt"));
    symlinkSync(outside, join(f.repo, "a.txt"));
    const result = await snap.restore(tree, []);
    expect(result.skipped).toEqual([{ path: "a.txt", reason: "link" }]);
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
  });

  test("keeps the execute bit on POSIX", async () => {
    const f = fixture({ "run.sh": "#!/bin/sh\necho hi\n" });
    if (process.platform === "win32") return;
    chmodSync(join(f.repo, "run.sh"), 0o755);
    const snap = await f.open();
    const { tree } = await snap.snapshot();
    rmSync(join(f.repo, "run.sh"));
    await snap.restore(tree, []);
    expect(statSync(join(f.repo, "run.sh")).mode & 0o111).not.toBe(0);
  });

  // spec: AC-CKPT-04
  test("files under text=auto, eol=crlf, ident and working-tree-encoding round-trip byte for byte", async () => {
    const attributes = [
      "auto.txt text=auto",
      "crlf.txt text eol=crlf",
      "ident.txt ident",
      "utf16.txt working-tree-encoding=UTF-16LE text",
      "",
    ].join("\n");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo\r\n", "utf16le")]);
    const files: Record<string, string | Uint8Array> = {
      ".gitattributes": attributes,
      "auto.txt": "mixed\r\nlines\nhere\r\n",
      "crlf.txt": "one\r\ntwo\r\n",
      "ident.txt": "$Id: 0123456789012345678901234567890123456789 $\n",
      "utf16.txt": utf16,
    };
    const f = fixture(files, false);
    const snap = await f.open();
    const { tree } = await snap.snapshot();
    for (const name of Object.keys(files)) writeFileSync(join(f.repo, name), "clobbered");
    rmSync(join(f.repo, "crlf.txt"));
    await snap.restore(tree, []);
    for (const [name, data] of Object.entries(files)) {
      expect(Buffer.from(readFileSync(join(f.repo, name))).equals(Buffer.from(data))).toBe(true);
    }
  });
});

describe("the user's repository", () => {
  // spec: AC-CKPT-02
  test("is byte-identical after 100 snapshots, and git status does not change", async () => {
    const f = fixture({ "a.txt": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n" });
    f.git("branch", "other");
    f.git("tag", "v1");
    f.git("gc", "-q"); // packed objects and refs, like a real clone
    writeFileSync(join(f.repo, "src", "b.ts"), "staged\n");
    f.git("add", "src/b.ts"); // a staged change in the user's real index
    writeFileSync(join(f.repo, "a.txt"), "unstaged edit\n");
    writeFileSync(join(f.repo, "untracked.txt"), "u\n");
    // Old timestamps on the user's objects: git "freshens" an object it finds already stored (as an alternate would
    // be), so a snapshot that touched them would show up as a changed mtime.
    const longAgo = new Date("2020-01-01T00:00:00Z");
    const objects = join(f.repo, ".git", "objects");
    for (const entry of readdirSync(objects, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) utimesSync(join(entry.parentPath, entry.name), longAgo, longAgo);
    }
    f.git("status", "--porcelain"); // let git refresh its own index first; the snapshots must not touch it afterwards
    const statusBefore = f.git("status", "--porcelain");
    const before = dump(join(f.repo, ".git"));

    const snap = await f.open();
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(f.repo, "src", "c.ts"), `c ${i}\n`);
      writeFileSync(join(f.repo, `new-${i % 7}.txt`), `new ${i}\n`);
      if (i % 10 === 9) rmSync(join(f.repo, `new-${i % 7}.txt`));
      await snap.snapshot();
    }

    expect(dump(join(f.repo, ".git"))).toEqual(before);

    // Put the working tree back as it was; git's own view of the repository must then be what it was too.
    writeFileSync(join(f.repo, "src", "c.ts"), "c\n");
    for (let i = 0; i < 7; i++) rmSync(join(f.repo, `new-${i}.txt`), { force: true });
    expect(f.git("status", "--porcelain")).toBe(statusBefore);
  }, 120_000);
});

describe("filter safety", () => {
  /** A repo whose attributes select a clean filter and a process filter, configured in local AND global config. */
  function trap(): {
    f: Fixture;
    command: (name: string) => string;
    marker: (name: string) => boolean;
    connections: () => number;
    stop: () => void;
  } {
    const tools = tempDir("tools");
    let connections = 0;
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
    const script = join(tools, "filter.js").replaceAll("\\", "/");
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
      `"${process.execPath.replaceAll("\\", "/")}" "${script}" "${join(tools, name).replaceAll("\\", "/")}" ${server.port}`;

    const f = fixture({
      "a.txt": "a\n",
      "b.dat": "b\n",
      ".gitattributes": "*.txt filter=cleaner\n*.dat filter=proc\n",
    });
    f.git("config", "filter.cleaner.clean", command("local-clean"));
    f.git("config", "filter.proc.process", command("local-process"));
    f.git("config", "core.fsmonitor", command("local-fsmonitor"));
    const hook = join(f.repo, ".git", "hooks", "post-index-change");
    writeFileSync(hook, `#!/bin/sh\n${command("hook")}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(
      join(f.home, ".gitconfig"),
      `[filter "cleaner"]\n\tclean = ${command("global-clean")}\n\tsmudge = ${command("global-smudge")}\n[filter "proc"]\n\tprocess = ${command("global-process")}\n`,
    );
    return {
      f,
      command,
      marker: (name) => existsSync(join(tools, name)),
      connections: () => connections,
      stop: () => server.stop(true),
    };
  }

  test("control: git add really does run these filters here, so the trap can detect one", async () => {
    const t = trap();
    try {
      writeFileSync(join(t.f.repo, "a.txt"), "changed\n");
      t.f.git("add", "a.txt");
      await Bun.sleep(500);
      for (const name of ["local-clean", "local-fsmonitor", "hook"]) expect(t.marker(name)).toBe(true);
      expect(t.connections()).toBeGreaterThan(0);
    } finally {
      t.stop();
    }
  }, 60_000);

  // spec: AC-CKPT-03
  test("GIT_* variables in the caller's environment cannot redirect git or inject configuration", async () => {
    const t = trap();
    try {
      const elsewhere = tempDir("elsewhere");
      const env = {
        ...baseEnv(t.f.home),
        GIT_DIR: join(elsewhere, "no-such-dir"),
        GIT_WORK_TREE: elsewhere,
        GIT_INDEX_FILE: join(elsewhere, "index"),
        GIT_OBJECT_DIRECTORY: join(elsewhere, "objects"),
        GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${t.command("env-fsmonitor")}'`,
      };
      const snap = await t.f.open("s1", env);
      const { tree } = await snap.snapshot();
      await Bun.sleep(500);
      expect(tree).toBe(t.f.git("rev-parse", "HEAD^{tree}").trim());
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(t.marker("env-fsmonitor")).toBe(false);
    } finally {
      t.stop();
    }
  }, 60_000);

  // spec: AC-CKPT-03
  test("snapshot and restore never run a configured filter or open a connection", async () => {
    const t = trap();
    try {
      const snap = await t.f.open();
      writeFileSync(join(t.f.repo, "a.txt"), "edited by the agent\n");
      writeFileSync(join(t.f.repo, "b.dat"), "edited too\n");
      writeFileSync(join(t.f.repo, "c.txt"), "brand new\n");
      const { tree } = await snap.snapshot();
      writeFileSync(join(t.f.repo, "a.txt"), "edited again\n");
      await snap.snapshot();
      await snap.restore(tree, []);
      await Bun.sleep(500); // a filter that had been started would have written its marker by now
      const names = ["local-clean", "local-process", "global-clean", "global-smudge", "global-process"];
      for (const name of [...names, "local-fsmonitor", "hook"]) {
        expect(t.marker(name)).toBe(false);
      }
      expect(t.connections()).toBe(0);
      expect(readFileSync(join(t.f.repo, "a.txt"), "utf8")).toBe("edited by the agent\n");
    } finally {
      t.stop();
    }
  }, 60_000);
});

describe("the snapshot module's git commands", () => {
  test("never use git add, checkout or checkout-index, which run filters (ADR-19)", () => {
    const dir = import.meta.dir;
    const sources = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).not.toMatch(/["'](add|checkout|checkout-index|stash|commit|reset|apply|clean|gc|prune)["']/);
    }
  });
});
