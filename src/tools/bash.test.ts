import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformCore } from "../platform/index.ts";
import { type AbsPath, Settings } from "../schema/index.ts";
import { openSnapshotter } from "../store/index.ts";
import {
  createBashTool,
  createReadTool,
  createToolRegistry,
  createWriteTool,
  type ToolContext,
  type ToolOutput,
} from "./index.ts";
import { commandEnv, scopedSettingsEnv, startShellSnapshot } from "./shell-env.ts";
import { context, text, workspace } from "./test-context.ts";

const BASH = Bun.which("bash") as AbsPath;

type Rig = { cwd: string; home: string; tmp: string; ctx: ToolContext };

async function rig(env: Record<string, string> = {}, settings: Record<string, unknown> = {}): Promise<Rig> {
  const cwd = await workspace();
  const home = await workspace();
  const tmp = await workspace();
  const windows = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "", TEMP: tmpdir() } : {};
  const launch = { PATH: process.env.PATH ?? "", HOME: home, SHELL: BASH, ...windows, ...env };
  const core = createPlatformCore({
    os: process.platform as "linux",
    arch: process.arch,
    execPath: process.execPath,
    env: launch,
    projectRoot: cwd as AbsPath,
    kill: (pid, signal) => process.kill(pid, signal),
    termGraceMs: 300,
  });
  const base = context(cwd);
  const ctx: ToolContext = {
    ...base,
    env: launch,
    settings: Settings.parse(settings),
    platform: { ...base.platform, ...core },
  };
  return { cwd, home, tmp, ctx };
}

async function bash(
  r: Rig,
  input: Record<string, unknown>,
  tool = createBashTool({ tmpDir: r.tmp }),
): Promise<ToolOutput> {
  const prepared = createToolRegistry([tool]).prepare("Bash", input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, r.ctx);
}

function snapshotOf(r: Rig, timeoutMs?: number) {
  return startShellSnapshot({
    platform: r.ctx.platform,
    userShell: BASH,
    cwd: r.cwd as AbsPath,
    env: r.ctx.env,
    sessionDir: join(r.tmp, "session"),
    group: "snapshot:s",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32")("Bash", () => {
  // spec: AC-TOOLS-06
  test("finds nvm's node through the snapshot; cwd carries over, exports and an outside cwd do not", async () => {
    const r = await rig();
    await mkdir(join(r.home, "nvm", "bin"), { recursive: true });
    await writeFile(join(r.home, "nvm", "bin", "node"), "#!/bin/sh\necho v99.0.0\n");
    await chmod(join(r.home, "nvm", "bin", "node"), 0o755);
    await writeFile(join(r.home, ".bash_profile"), `export PATH="${r.home}/nvm/bin:$PATH"\n`);
    const tool = createBashTool({ tmpDir: r.tmp, snapshot: snapshotOf(r) });

    expect(text(await bash(r, { command: "node" }, tool))).toBe("v99.0.0");
    await bash(r, { command: "export LEAK=1" }, tool);
    expect(text(await bash(r, { command: 'echo "[$' + '{LEAK-unset}]"' }, tool))).toBe("[unset]");

    await mkdir(join(r.cwd, "sub"));
    const cd = await bash(r, { command: "cd sub && pwd" }, tool);
    expect(text(cd)).toBe(join(r.cwd, "sub"));
    expect(cd.meta?.effects).toEqual([{ kind: "cwd", path: join(r.cwd, "sub") }]);

    const out = await bash(r, { command: "cd / && pwd" }, tool);
    expect(text(out)).toBe(`/\nShell cwd was reset to ${r.cwd}`);
    expect(out.meta?.effects).toEqual([]);
  });

  // spec: AC-TOOLS-25
  test("a snapshot that outlives 10 s is abandoned, its process group killed, the note shown once", async () => {
    const r = await rig();
    const pidFile = join(r.home, "daemon.pid");
    await writeFile(join(r.home, ".bash_profile"), `sleep 300 &\necho $! > ${pidFile}\nsleep 30\n`);
    const tool = createBashTool({ tmpDir: r.tmp, snapshot: snapshotOf(r) });

    const first = await bash(r, { command: 'echo "home=$HOME"' }, tool);
    expect(text(first)).toContain(`home=${r.home}`);
    expect(text(first)).toContain("didn't finish in 10 s; using Dovet's own environment");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(alive(pid)).toBe(false);
    expect(text(await bash(r, { command: "true" }, tool))).not.toContain("Shell setup");
  }, 30_000);

  // spec: AC-TOOLS-25
  test("a PATH with spaces and $ survives the snapshot unchanged", async () => {
    const r = await rig();
    const odd = "/opt/my tools/$HOME/bin";
    await writeFile(join(r.home, ".bash_profile"), `export PATH='${odd}':"$PATH"\n`);
    const tool = createBashTool({ tmpDir: r.tmp, snapshot: snapshotOf(r) });
    expect(text(await bash(r, { command: 'printf %s "$PATH"' }, tool)).startsWith(`${odd}:`)).toBe(true);
  });

  // spec: AC-TOOLS-27
  test("the command environment has the agent variables and none of CI, NO_COLOR, BUN_OPTIONS or secrets", async () => {
    const r = await rig(
      { BUN_OPTIONS: "--inspect", MY_API_TOKEN: "t0p", KEEP_ME_KEY: "k", PLAIN: "ok" },
      { shell: { passEnv: ["KEEP_ME_KEY"] } },
    );
    const out = text(await bash(r, { command: "env" }));
    const lines = out.split("\n");
    expect(lines).toContain("GIT_EDITOR=true");
    expect(lines).toContain("AI_AGENT=dovet");
    expect(lines).toContain("DOVET=1");
    expect(lines).toContain("PLAIN=ok");
    expect(lines).toContain("KEEP_ME_KEY=k");
    for (const name of ["CI", "NO_COLOR", "BUN_OPTIONS", "MY_API_TOKEN"]) {
      expect(lines.some((l) => l.startsWith(`${name}=`))).toBe(false);
    }
  });

  // spec: AC-TOOLS-27
  test("a 200 KB line is cut in the middle and NUL bytes are replaced", async () => {
    const r = await rig();
    const out = text(await bash(r, { command: `head -c 200000 /dev/zero | tr '\\0' 'x'; echo; printf 'a\\0\\0b\\n'` }));
    const [long, binary] = out.split("\n");
    expect(long).toContain("… [195000 chars cut] …");
    expect(long?.length).toBeLessThan(5100);
    expect(binary).toBe("a[binary output, 2 bytes]b");
  });

  // spec: AC-TOOLS-39
  test("a heredoc with a template placeholder and a 200 KB command both run; `!=` is not history-expanded", async () => {
    const r = await rig();
    const placeholder = "$" + "{index + 1}";
    const heredoc = `cat <<'EOF'\nconst n = ${placeholder};\nEOF`;
    expect(text(await bash(r, { command: heredoc }))).toBe(`const n = ${placeholder};`);
    const big = `echo start; : '${"y".repeat(200_000)}'; echo end`;
    expect(text(await bash(r, { command: big }))).toBe("start\nend");
    expect(text(await bash(r, { command: `echo '.x != .y'; case $- in *H*) echo on;; *) echo off;; esac` }))).toBe(
      ".x != .y\noff",
    );
  });

  // spec: AC-TOOLS-39
  test("no script or cwd files remain after a command is killed or fails", async () => {
    const r = await rig();
    const abort = new AbortController();
    r.ctx = { ...r.ctx, signal: abort.signal };
    const running = bash(r, { command: "echo started; sleep 60" });
    for (let i = 0; i < 100 && (await readdir(join(r.tmp, "sh")).catch(() => [])).length === 0; i++)
      await Bun.sleep(20);
    expect((await readdir(join(r.tmp, "sh"))).length).toBeGreaterThan(0);
    abort.abort();
    const out = await running;
    expect(out.status).toBe("interrupted");
    expect(text(out)).toContain("Interrupted by the user");
    expect(await readdir(join(r.tmp, "sh"))).toEqual([]);
  });

  // spec: AC-TOOLS-25
  test("a daemon the rc starts is killed even when the snapshot finishes in time", async () => {
    const r = await rig();
    const pidFile = join(r.home, "daemon.pid");
    await writeFile(join(r.home, ".bash_profile"), `export FROM_RC=1\nsleep 300 &\necho $! > ${pidFile}\n`);
    const snapshot = snapshotOf(r);
    expect((await snapshot.ready()).env?.FROM_RC).toBe("1");
    expect(alive(Number((await readFile(pidFile, "utf8")).trim()))).toBe(false);
  });

  // spec: AC-TOOLS-25
  test("volatile shell variables are not captured", async () => {
    const r = await rig();
    await writeFile(join(r.home, ".bash_profile"), "export PS1=x ZSH_FOO=1 P9K_BAR=1 KEEP=1 OLDPWD=/x\n");
    const env = (await snapshotOf(r).ready()).env ?? {};
    expect(env.KEEP).toBe("1");
    for (const name of ["PS1", "ZSH_FOO", "P9K_BAR", "OLDPWD", "PWD", "SHLVL"]) expect(name in env).toBe(false);
  });

  // spec: AC-TOOLS-25
  test("a shell that cannot be started falls back to the inherited environment with one note", async () => {
    const r = await rig();
    const tool = createBashTool({
      tmpDir: r.tmp,
      snapshot: startShellSnapshot({
        platform: r.ctx.platform,
        userShell: "/nonexistent/zsh" as AbsPath,
        cwd: r.cwd as AbsPath,
        env: r.ctx.env,
        sessionDir: join(r.tmp, "session"),
        group: "snapshot:s",
      }),
    });
    const first = text(await bash(r, { command: "echo ran" }, tool));
    expect(first).toContain("ran");
    expect(first).toContain("could not be run");
    expect(text(await bash(r, { command: "echo ran" }, tool))).toBe("ran");
  });

  test("a command killed by a signal and a missing envFile are reported plainly", async () => {
    const r = await rig({}, { shell: { envFile: "missing.env" } });
    const missing = await bash(r, { command: "true" });
    expect(missing.status).toBe("error");
    expect(text(missing)).toContain("shell.envFile (missing.env) can't be read");
    const killed = await bash(await rig(), { command: "kill -9 $$" });
    expect(text(killed)).toContain("Killed by a signal");
  });

  test("an interrupt while waiting for the snapshot returns at once", async () => {
    const r = await rig();
    await writeFile(join(r.home, ".bash_profile"), "sleep 30\n");
    const abort = new AbortController();
    r.ctx = { ...r.ctx, signal: abort.signal };
    const tool = createBashTool({ tmpDir: r.tmp, snapshot: snapshotOf(r) });
    setTimeout(() => abort.abort(), 100);
    const started = Date.now();
    const out = await bash(r, { command: "true" }, tool);
    expect(out.status).toBe("interrupted");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a failing command reports its exit code and a timeout kills it", async () => {
    const r = await rig();
    const failed = await bash(r, { command: "echo oops; exit 3" });
    expect(failed.status).toBe("error");
    expect(text(failed)).toBe("Exit code 3\noops");
    const slow = await bash(r, { command: "sleep 30", timeout: 300 });
    expect(slow.status).toBe("timeout");
    expect(text(slow)).toContain("Command timed out after 0s");
  });
});

describe.skipIf(process.platform === "win32")("settings env", () => {
  // spec: AC-CLI-12
  test("user env reaches the command, never Dovet's own process; a launch value wins and is listed", async () => {
    const r = await rig({ FROM_LAUNCH: "launch" }, { env: { FROM_USER: "user", FROM_LAUNCH: "settings" } });
    const out = text(await bash(r, { command: 'echo "$FROM_USER/$FROM_LAUNCH"' }));
    expect(out).toBe("user/launch");
    expect(process.env.FROM_USER).toBeUndefined();
    const { ignored } = commandEnv({
      os: "linux",
      launch: { FROM_LAUNCH: "launch" },
      snapshot: null,
      settingsEnv: { FROM_USER: "user", FROM_LAUNCH: "settings" },
    });
    expect(ignored).toEqual(["FROM_LAUNCH"]);
  });

  // spec: AC-CLI-12
  test("project env is dropped until the folder is trusted, and PATH, LD_PRELOAD and GIT_* are refused even then", () => {
    const project = { PATH: "/evil", LD_PRELOAD: "/x.so", GIT_SSH_COMMAND: "x", NODE_OPTIONS: "-r x", SAFE: "1" };
    expect(scopedSettingsEnv({ user: { U: "u" }, project, projectTrusted: false })).toEqual({
      env: { U: "u" },
      refused: [],
    });
    const trusted = scopedSettingsEnv({ user: { U: "u" }, project, projectTrusted: true });
    expect(trusted.env).toEqual({ U: "u", SAFE: "1" });
    expect(trusted.refused).toEqual(["PATH", "LD_PRELOAD", "GIT_SSH_COMMAND", "NODE_OPTIONS"]);
  });

  test("shell.envFile is applied after the snapshot", async () => {
    const r = await rig({}, { shell: { envFile: "vars.env" } });
    await writeFile(join(r.home, ".bash_profile"), "export A=fromrc\n");
    await writeFile(join(r.cwd, "vars.env"), "# c\nexport A=1\nB='two words'\n");
    const tool = createBashTool({ tmpDir: r.tmp, snapshot: snapshotOf(r) });
    expect(text(await bash(r, { command: 'echo "$A|$B"' }, tool))).toBe("1|two words");
  });
});

const gitIn = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

async function pidOf(path: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const n = Number((await readFile(path, "utf8").catch(() => "")).trim());
    if (n > 0) return n;
    await Bun.sleep(20);
  }
  throw new Error(`${path} never got a pid`);
}

describe("Bash on every OS", () => {
  // spec: AC-PLAT-04
  test("non-ASCII output round-trips", async () => {
    const r = await rig();
    expect(text(await bash(r, { command: 'echo "héllo 你好 🎉"' }))).toBe("héllo 你好 🎉");
  });

  // spec: AC-TOOLS-08
  test("a timeout kills grandchildren too", async () => {
    const r = await rig();
    // Git Bash's $! is an MSYS pid; /proc/<pid>/winpid is the Windows one.
    const out = await bash(r, {
      command: "(sleep 300 & (cat /proc/$!/winpid 2>/dev/null || echo $!) > gc.pid; wait)",
      timeout: 1500,
    });
    expect(out.status).toBe("timeout");
    const pid = await pidOf(join(r.cwd, "gc.pid"));
    await Bun.sleep(200);
    expect(alive(pid)).toBe(false);
  });

  // spec: AC-PLAT-06
  test("a session cwd deleted mid-session gives a clear error and resets to the project root", async () => {
    const r = await rig();
    const sub = join(r.cwd, "sub");
    await mkdir(sub);
    const inSub = { ...r, ctx: { ...r.ctx, session: { ...r.ctx.session, cwd: sub as AbsPath } } };
    await rm(sub, { recursive: true });
    const out = await bash(inSub, { command: "echo hi" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain(`The working directory ${sub} no longer exists`);
    expect(text(out)).toContain(`reset to ${r.cwd}`);
    expect(out.meta?.effects).toEqual([{ kind: "cwd", path: r.cwd }]);
  });

  // spec: AC-PLAT-06
  test.skipIf(process.platform !== "win32")(
    "Git Bash: 2>nul creates no nul file; Python prints non-ASCII",
    async () => {
      const r = await rig();
      const out = await bash(r, { command: "echo x 2>nul; echo y >nul; echo done" });
      expect(text(out)).toContain("done");
      expect(text(out)).toContain("rewritten to /dev/null");
      expect(await readdir(r.cwd)).not.toContain("nul");
      if (Bun.which("python") !== null) {
        const py = await bash(r, { command: `python -c "print('héllo 你好')"` });
        expect(text(py)).toBe("héllo 你好");
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("Bash: results", () => {
  // spec: AC-TOOLS-07
  test("grep with no match is a success, false is a failure with a 10k excerpt, 50k output goes to a file", async () => {
    const r = await rig();
    await writeFile(join(r.cwd, "a.txt"), "hello\n");
    const none = await bash(r, { command: "grep nothing a.txt" });
    expect(none.status).toBe("ok");
    expect(none.meta?.exitCode).toBe(1);
    expect((await bash(r, { command: "false" })).status).toBe("error");

    const failed = await bash(r, { command: "yes 0123456789 | head -c 40000; exit 1" });
    expect(failed.status).toBe("error");
    expect(text(failed).startsWith("Exit code 1\n")).toBe(true);
    expect(text(failed).length).toBeLessThan(10_100);
    expect(failed.meta?.offloadPath).toBeUndefined();

    const big = await bash(r, { command: "yes 0123456789 | head -c 50000" });
    expect(big.status).toBe("ok");
    const path = big.meta?.offloadPath;
    expect(path).toBeDefined();
    expect(text(big)).toContain(`Full output saved to ${path}`);
    expect(text(big).length).toBeLessThan(2_400);
    expect((await readFile(path as string, "utf8")).length).toBeGreaterThan(49_000);

    const edge = await bash(r, { command: "yes 0123456789 | head -c 29999" });
    expect(edge.meta?.offloadPath).toBeUndefined();
  });

  test("a command that floods the output is stopped at the cap and says so", async () => {
    const r = await rig();
    const tool = createBashTool({ tmpDir: r.tmp, outputCapBytes: 2_000_000 });
    const out = await bash(r, { command: "yes" }, tool);
    expect(text(out)).toContain("Output exceeded 2 MB; the command was stopped");
  });
});

describe.skipIf(process.platform === "win32")("Bash: process lifecycle", () => {
  // spec: AC-TOOLS-08
  test("git commit without a message is refused before it runs", async () => {
    const r = await rig();
    gitIn(r.cwd, "init", "-q");
    await writeFile(join(r.cwd, "a.txt"), "x\n");
    gitIn(r.cwd, "add", "a.txt");
    const out = await bash(r, { command: "git commit" });
    expect(out.status).toBe("error");
    expect(text(out)).toBe(
      'This command needs an interactive terminal, which isn\'t available. Use a non-interactive form (e.g. git commit -m "…").',
    );
    expect(() => gitIn(r.cwd, "log")).toThrow();
  });

  // spec: AC-TOOLS-26
  test("a backgrounded sleep does not hold the command; it is stopped and the result says so", async () => {
    const r = await rig();
    const out = await bash(r, { command: `sleep 1000 & echo $! > ${r.cwd}/bg.pid; echo done` });
    expect(out.status).toBe("ok");
    expect(out.meta?.durationMs).toBeLessThan(1000);
    expect(text(out)).toContain("done");
    expect(text(out)).toContain(
      `Stopped 1 background process(es) the command left running (e.g. "sleep 1000"). Long-running servers aren't supported in v0.1; start them yourself in a terminal.`,
    );
    expect(alive(await pidOf(join(r.cwd, "bg.pid")))).toBe(false);
  });

  // spec: AC-TOOLS-40
  test("processes that left the group by setsid or a double fork are stopped and named", async () => {
    const r = await rig();
    const daemon = (n: string, argv: string): string =>
      `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); open F, ">", "${r.cwd}/${n}.pid"; print F $$; close F; exec ${argv}' &`;
    const out = await bash(r, {
      command: `${daemon("a", '"sleep", "1001"')}\n${daemon("b", '"sleep", "1002"')}\nsleep 0.3`,
    });
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("Stopped 2 background process(es)");
    expect(text(out)).toContain("sleep 1001");
    expect(text(out)).toContain("sleep 1002");
    for (const n of ["a", "b"]) expect(alive(await pidOf(join(r.cwd, `${n}.pid`)))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Bash: sweep edge cases", () => {
  const escapee = (r: Rig, n: string, pre: string, wrapper = ""): string =>
    `${wrapper}perl -MPOSIX -e 'fork and exit; POSIX::setsid(); ${pre} open F, ">", "${r.cwd}/${n}.pid"; print F $$; close F; exec "/bin/sleep", "1003"' &`;

  // spec: AC-TOOLS-40
  test("an escapee that ignores SIGTERM is killed after the grace period", async () => {
    const r = await rig();
    const out = await bash(r, { command: `${escapee(r, "t", '$SIG{TERM}="IGNORE";')}\nsleep 0.3` });
    expect(text(out)).toContain("Stopped 1 background process(es)");
    await Bun.sleep(100);
    expect(alive(await pidOf(join(r.cwd, "t.pid")))).toBe(false);
  });

  // spec: AC-TOOLS-26
  test("an escapee with a cleared environment holds the pipe for at most the 500 ms drain", async () => {
    const r = await rig();
    const perl = Bun.which("perl") as string;
    const started = Date.now();
    const cleared = `env -i ${perl} -MPOSIX -e 'fork and exit; POSIX::setsid(); open F, ">", "${r.cwd}/e.pid"; print F $$; close F; exec "/bin/sleep", "1004"' &`;
    const out = await bash(r, { command: `${cleared}\nsleep 0.3; echo done` });
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("done");
    expect(Date.now() - started).toBeLessThan(2500);
    const pid = await pidOf(join(r.cwd, "e.pid"));
    process.kill(pid, "SIGKILL");
  });

  // spec: AC-TOOLS-40
  test("the criterion's own commands: setsid sleep and timeout sleep", async () => {
    if (Bun.which("setsid") === null || Bun.which("timeout") === null) return;
    const r = await rig();
    const out = await bash(r, { command: "setsid sleep 1000 &\ntimeout 900 sleep 1001 &\nsleep 0.3" });
    expect(text(out)).toContain("sleep 1000");
    expect(text(out)).toContain("timeout 900 sleep 1001");
  });

  test("a sweep that cannot run is reported and does not fail the command", async () => {
    const r = await rig();
    r.ctx = {
      ...r.ctx,
      platform: { ...r.ctx.platform, sweep: () => Promise.reject(new Error("ps not found")) },
    };
    const out = await bash(r, { command: "echo hi" });
    expect(out.status).toBe("ok");
    expect(text(out)).toBe("hi\nCouldn't look for processes the command left running: ps not found");
  });

  test("a timeout shows the model at most a 10,000-character excerpt", async () => {
    const r = await rig();
    const out = await bash(r, { command: "yes 0123456789 | head -c 3000000; sleep 5", timeout: 1500 });
    expect(out.status).toBe("timeout");
    expect(text(out).length).toBeLessThan(10_200);
  });

  test("the working file holds the output as printed: JSON is not reformatted", async () => {
    const r = await rig();
    const out = await bash(r, { command: "echo '['; seq 1 6000 | sed 's/$/,/'; echo '0]'" });
    const file = await readFile(out.meta?.offloadPath as string, "utf8");
    expect(file.startsWith("[\n1,\n2,\n")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("Bash: files read and changed", () => {
  async function repo(): Promise<Rig> {
    const r = await rig();
    gitIn(r.cwd, "init", "-q");
    await writeFile(join(r.cwd, "a.ts"), "const a   =  1\n");
    await writeFile(join(r.cwd, "keep.ts"), "keep\n");
    gitIn(r.cwd, "add", ".");
    gitIn(r.cwd, "commit", "-q", "-m", "init");
    const snapshotter = await openSnapshotter({
      workspace: r.cwd,
      projectDir: join(r.tmp, "project"),
      session: "s",
      env: r.ctx.env,
      platform: process.platform,
    });
    r.ctx = { ...r.ctx, snapshots: snapshotter };
    return r;
  }
  const run = (r: Rig, tool: "Read" | "Write", input: Record<string, unknown>): Promise<ToolOutput> => {
    const def = tool === "Read" ? createReadTool() : createWriteTool();
    const prepared = createToolRegistry([def]).prepare(tool, input);
    if (!prepared.ok) throw new Error(prepared.message);
    return def.run(prepared.input as never, r.ctx);
  };

  // spec: AC-TOOLS-41
  test("a command that reformats a read file lists it as changed; the next Write without a re-read is stale", async () => {
    const r = await repo();
    const file = join(r.cwd, "a.ts");
    await run(r, "Read", { file_path: file });
    const out = await bash(r, { command: "printf 'const a = 1;\\n' > a.ts; printf 'new\\nfile\\n' > b.ts" });
    expect(text(out)).toBe(
      "(no output)\nFiles changed while this ran: a.ts (+1 −1, re-read before editing), b.ts (+2 −0)",
    );
    expect(out.meta?.fileChanges).toEqual([
      { path: file, op: "modify", added: 1, removed: 1 },
      { path: join(r.cwd, "b.ts"), op: "create", added: 2, removed: 0 },
    ]);
    const refused = await run(r, "Write", { file_path: file, content: "mine\n" });
    expect(refused.status).toBe("error");
    expect(text(refused)).toContain("changed since you read it");
    expect(await readFile(file, "utf8")).toBe("const a = 1;\n");
    await run(r, "Read", { file_path: file });
    expect((await run(r, "Write", { file_path: file, content: "mine\n" })).status).toBe("ok");
  });

  test("more than 20 changed files are counted, and an unchanged tree lists nothing", async () => {
    const r = await repo();
    expect(text(await bash(r, { command: "true" }))).toBe("(no output)");
    const out = await bash(r, { command: "for i in $(seq 1 25); do echo $i > f$i.txt; done" });
    expect(text(out)).toContain("and 5 more");
    expect(text(out).match(/f\d+\.txt/g)?.length).toBe(20);
  });

  // spec: AC-TOOLS-41
  test("cat, head and grep of one file count as a read of it; pipes and empty output do not", async () => {
    const r = await repo();
    const file = join(r.cwd, "a.ts");
    await bash(r, { command: "cat a.ts | head -1" });
    expect(r.ctx.readState.get(file)).toBeUndefined();
    await bash(r, { command: "grep nothing a.ts" });
    expect(r.ctx.readState.get(file)).toBeUndefined();
    await bash(r, { command: "grep -n const a.ts" });
    expect(r.ctx.readState.get(file)?.partial).toBe(true);
    await bash(r, { command: "head -n 1 a.ts" });
    expect(r.ctx.readState.get(file)?.partial).toBe(true);
    await bash(r, { command: "cat a.ts" });
    const whole = r.ctx.readState.get(file);
    expect(whole?.partial).toBe(false);
    expect(whole?.size).toBe(15);
    expect(whole?.sha256).toBe(new Bun.CryptoHasher("sha256").update("const a   =  1\n").digest("hex"));
  });
});
