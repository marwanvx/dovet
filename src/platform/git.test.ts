// Dovet's own git calls, with real git and marker files: a marker appears only if git ran what the trap configured.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_HARDENING_ARGS, type GitCall, hardenedGitEnv, readGitHead, runHardenedGit } from "./git.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function tempDir(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "dovet-git-")));
  dirs.push(d);
  return d;
}

const gitPath = Bun.which("git") ?? "git";
const slash = (p: string): string => p.replaceAll("\\", "/");

function setup(): {
  home: string;
  env: Record<string, string | undefined>;
  git: (cwd: string, ...a: string[]) => string;
} {
  const home = tempDir();
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync([gitPath, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  return { home, env, git };
}

/** A command that creates `marker`, then runs `then` (argv) with stdio passed through. */
function markerCommand(marker: string, then: string[] = []): string {
  const script = join(tempDir(), "mark.js");
  writeFileSync(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      "writeFileSync(process.argv[2], 'ran');",
      `const then = ${JSON.stringify(then)};`,
      "if (then.length > 0) process.exit(spawnSync(then[0], [...then.slice(1), ...process.argv.slice(3)], { stdio: 'inherit' }).status ?? 1);",
      "",
    ].join("\n"),
  );
  return `"${slash(process.execPath)}" "${slash(script)}" "${slash(marker)}"`;
}

describe("AC-CLI-14: Dovet's own git calls", () => {
  // spec: AC-CLI-14
  test("in a partial clone, reading a missing blob doesn't fetch it", async () => {
    const { env, git } = setup();
    const root = tempDir();
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "hello\n");
    git(origin, "add", "a.txt");
    git(origin, "commit", "-qm", "one");
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${slash(origin)}`, "clone");
    const clone = join(root, "clone");
    const marker = join(root, "fetched");
    git(clone, "config", "remote.origin.uploadpack", markerCommand(marker, [gitPath, "upload-pack"]));
    const blob = git(clone, "rev-parse", "HEAD:a.txt").trim();

    const r = await runHardenedGit({ git: gitPath, cwd: clone, env }, ["cat-file", "-p", blob]);

    expect(r.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    // control: plain git does fetch it here, so the marker can detect a fetch
    git(clone, "cat-file", "-p", blob);
    expect(existsSync(marker)).toBe(true);
  }, 60_000);

  // spec: AC-CLI-14
  test("the environment block's git calls run no clean filter, in the repo or a nested one", async () => {
    const { env, git } = setup();
    const repo = tempDir();
    const nested = join(repo, "vendor", "lib");
    const markers = { outer: join(repo, "..", `${Date.now()}-outer`), inner: join(repo, "..", `${Date.now()}-inner`) };
    dirs.push(markers.outer, markers.inner);
    for (const [dir, marker] of [
      [repo, markers.outer],
      [nested, markers.inner],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, ".gitattributes"), "*.txt filter=trap\n");
      writeFileSync(join(dir, "a.txt"), "one\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "one");
      git(dir, "config", "filter.trap.clean", markerCommand(marker));
      writeFileSync(join(dir, "a.txt"), "two\n");
    }

    for (const cwd of [repo, nested]) {
      expect(await readGitHead({ git: gitPath, cwd, env })).toEqual({ kind: "branch", name: "main" });
    }

    expect(existsSync(markers.outer)).toBe(false);
    expect(existsSync(markers.inner)).toBe(false);
    // control: `git status` runs the clean filter on the modified file
    git(repo, "status", "--porcelain");
    expect(existsSync(markers.outer)).toBe(true);
  }, 60_000);

  // spec: AC-CLI-14
  test("a configured credential helper and askpass are never run", async () => {
    const { env, git } = setup();
    const repo = tempDir();
    git(repo, "init", "-q");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }),
    });
    try {
      const helperMarker = join(repo, "..", `${Date.now()}-helper`);
      dirs.push(helperMarker);
      git(repo, "config", "credential.helper", `!${markerCommand(helperMarker)}`);
      const askMarker = join(repo, "..", `${Date.now()}-ask`);
      dirs.push(askMarker);
      const envAskMarker = join(repo, "..", `${Date.now()}-env-ask`);
      dirs.push(envAskMarker);
      const askEnv: Record<string, string> = {};
      if (process.platform !== "win32") {
        const script = (marker: string): string => {
          const path = join(tempDir(), "ask.sh");
          writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n`);
          chmodSync(path, 0o755);
          return path;
        };
        git(repo, "config", "core.askPass", script(askMarker));
        askEnv.GIT_ASKPASS = script(envAskMarker);
        askEnv.SSH_ASKPASS = script(envAskMarker);
      }
      const call: GitCall = { git: gitPath, cwd: repo, env: { ...env, ...askEnv, GCM_INTERACTIVE: "always" } };

      const r = await runHardenedGit(call, ["ls-remote", `http://127.0.0.1:${server.port}/repo.git`]);

      expect(r.code).not.toBe(0);
      expect(existsSync(helperMarker)).toBe(false);
      expect(existsSync(askMarker)).toBe(false);
      expect(existsSync(envAskMarker)).toBe(false);
    } finally {
      await server.stop(true);
    }
  }, 60_000);
});

describe("hardening", () => {
  // spec: AC-CLI-14
  test("the environment drops GIT_* and askpass variables and sets the no-fetch, no-prompt, no-lock values", () => {
    const env = hardenedGitEnv({
      PATH: "/bin",
      GIT_TRACE: "1",
      git_trace2_event: "/tmp/t",
      GIT_ASKPASS: "/x",
      GIT_DIR: "/elsewhere",
      SSH_ASKPASS: "/y",
      GCM_INTERACTIVE: "always",
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: "/bin",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    });
  });

  // spec: AC-CLI-14
  test("every call takes no optional locks and resets credential helpers and askpass", () => {
    expect(GIT_HARDENING_ARGS.slice(0, 5)).toEqual([
      "--no-optional-locks",
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
    ]);
  });
});

describe("readGitHead", () => {
  test("a detached HEAD gives its short commit, and a plain folder gives null", async () => {
    const { env, git } = setup();
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "one");
    git(repo, "checkout", "-q", "--detach");
    const short = git(repo, "rev-parse", "--short", "HEAD").trim();
    expect(await readGitHead({ git: gitPath, cwd: repo, env })).toEqual({ kind: "detached", commit: short });
    expect(await readGitHead({ git: gitPath, cwd: tempDir(), env })).toBe(null);
  }, 60_000);
});
