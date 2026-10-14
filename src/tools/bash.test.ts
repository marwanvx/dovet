import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlatformCore } from "../platform/index.ts";
import { type AbsPath, Settings } from "../schema/index.ts";
import { createBashTool, createToolRegistry, type ToolContext, type ToolOutput } from "./index.ts";
import { commandEnv, scopedSettingsEnv, startShellSnapshot } from "./shell-env.ts";
import { context, text, workspace } from "./test-context.ts";

const BASH = Bun.which("bash") as AbsPath;

type Rig = { cwd: string; home: string; tmp: string; ctx: ToolContext };

async function rig(env: Record<string, string> = {}, settings: Record<string, unknown> = {}): Promise<Rig> {
  const cwd = await workspace();
  const home = await workspace();
  const tmp = await workspace();
  const launch = { PATH: process.env.PATH ?? "", HOME: home, SHELL: BASH, ...env };
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

describe("Bash", () => {
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

describe("settings env", () => {
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
    await writeFile(join(r.cwd, "vars.env"), "# c\nexport A=1\nB='two words'\n");
    expect(text(await bash(r, { command: 'echo "$A|$B"' }))).toBe("1|two words");
  });
});
