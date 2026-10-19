// Sandbox in the shell tools: auto-allow, retry, hygiene, violations, boundary (M2-01).
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeShell,
  decide,
  expandGlob,
  fakeSandboxService,
  isDirectory,
  loadRules,
  loadShellParsers,
  type RuleSet,
  ruleSetFromSettings,
  type ShellParsers,
  sandboxStatus,
} from "../policy/index.ts";
import { type PermissionMode, Settings } from "../schema/index.ts";
import { createBashTool, createToolRegistry } from "./index.ts";
import { context, text, workspace } from "./test-context.ts";
import type { ToolContext } from "./types.ts";

const sandboxedOf = (
  tool: { describeAction(i: unknown, c: ToolContext): { kind: string; sandboxed?: boolean } },
  input: unknown,
  ctx: ToolContext,
): boolean => {
  const d = tool.describeAction(input, ctx) as { kind: string; sandboxed?: boolean };
  return d.kind === "shell" && d.sandboxed === true;
};

// Sandbox config paths are POSIX form on every OS (permissions §3.3); native tmpdirs need the same normalization.
const px = (p: string): string => p.replace(/\\/g, "/");

let parsers: ShellParsers;
const ready = loadShellParsers().then((p) => {
  parsers = p;
});

const rulesFor = (lists: { allow?: string[]; ask?: string[]; deny?: string[] } = {}): RuleSet => {
  const texts = (xs: string[] = []) => xs.map((text) => ({ text }));
  return loadRules(
    [
      {
        file: "/p/s.json",
        baseDir: "/work",
        allow: texts(lists.allow),
        ask: texts(lists.ask),
        deny: texts(lists.deny),
      },
    ],
    { os: process.platform as "linux", home: "/home/u", canonicalize: (p) => p },
  ).rules;
};

const shDecide = (
  command: string,
  mode: PermissionMode,
  lists: Parameters<typeof rulesFor>[0],
  over: { sandboxed?: boolean; sandboxAutoAllow?: boolean } = {},
) => {
  const st = {
    mode,
    rules: rulesFor(lists),
    env: {
      os: process.platform as "linux",
      home: "/home/u",
      cwd: "/work",
      workingDirs: ["/work"] as readonly string[],
      canonicalize: (p: string) => p,
      pid: 1,
      ppid: 0,
      selfNames: ["dovet", "bun"] as readonly string[],
    },
    ...(over.sandboxAutoAllow === undefined ? {} : { sandboxAutoAllow: over.sandboxAutoAllow }),
  };
  const analysis = analyzeShell(parsers, "bash", command, {
    cwd: "/work",
    workingDirs: ["/work"],
    home: "/home/u",
    glob: expandGlob,
    isDirectory,
  });
  return decide({ tool: "Bash", action: { kind: "shell", analysis, sandboxed: over.sandboxed ?? false } }, st);
};

// spec: AC-PERM-09
describe("sandbox auto-allow", () => {
  test("sandboxed npm test runs without prompt in Manual; ask rule and plan mode still prompt", async () => {
    await ready;
    expect(shDecide("npm test", "default", {}, { sandboxed: true, sandboxAutoAllow: true }).behavior).toBe("allow");
    expect(
      shDecide("git push", "default", { ask: ["Bash(git push *)"] }, { sandboxed: true, sandboxAutoAllow: true })
        .behavior,
    ).toBe("ask");
    expect(shDecide("npm test", "plan", {}, { sandboxed: true, sandboxAutoAllow: true }).behavior).toBe("ask");
    expect(shDecide("npm test", "default", {}, { sandboxed: false, sandboxAutoAllow: true }).behavior).toBe("ask");
  });

  test("a bare Bash ask rule is skipped for sandboxed commands but content rules still prompt", async () => {
    await ready;
    expect(
      shDecide("npm test", "default", { ask: ["Bash"] }, { sandboxed: true, sandboxAutoAllow: true }).behavior,
    ).toBe("allow");
    expect(
      shDecide("npm test", "default", { ask: ["Bash"] }, { sandboxed: false, sandboxAutoAllow: true }).behavior,
    ).toBe("ask");
  });

  test("describeAction is sandboxed only with a healthy service", async () => {
    await ready;
    const cwd = await workspace();
    const tool = createBashTool({ tmpDir: await workspace() });
    const on: ToolContext = {
      ...context(cwd),
      sandbox: fakeSandboxService("on", "bubblewrap"),
      settings: Settings.parse({}),
    };
    const off: ToolContext = { ...on, sandbox: fakeSandboxService("off", "none") };
    expect(sandboxedOf(tool, { command: "npm test" }, on)).toBe(true);
    expect(sandboxedOf(tool, { command: "npm test" }, off)).toBe(false);
  });

  test("powershell routing honors health and the retry flag", async () => {
    const cwd = await workspace();
    const tool = createBashTool({ tmpDir: await workspace(), powershell: { edition: "pwsh" } });
    const on: ToolContext = {
      ...context(cwd),
      sandbox: fakeSandboxService("on", "bubblewrap"),
      settings: Settings.parse({}),
    };
    expect(sandboxedOf(tool, { command: "Get-ChildItem C:\\work" }, on)).toBe(true);
    expect(sandboxedOf(tool, { command: "Get-ChildItem C:\\work", dangerouslyDisableSandbox: true }, on)).toBe(false);
  });

  test("failIfUnavailable refuses when sandbox failed to start, but allows unsandboxed when deliberately disabled", async () => {
    if (process.platform === "win32") return;
    await ready;
    const cwd = await workspace();
    const tool = createBashTool({ tmpDir: await workspace() });
    const failedCtx: ToolContext = {
      ...context(cwd),
      sandbox: fakeSandboxService("off", "none"),
      settings: Settings.parse({ sandbox: { failIfUnavailable: true } }),
    };
    const disabledCtx: ToolContext = {
      ...context(cwd),
      sandbox: fakeSandboxService("off", "none"),
      settings: Settings.parse({ sandbox: { enabled: false, failIfUnavailable: true } }),
    };
    const failedRes = await tool.run({ command: "echo hi" }, failedCtx);
    expect(failedRes.status).toBe("error");
    expect(text(failedRes)).toContain("failIfUnavailable is true");

    const disabledRes = await tool.run({ command: "echo hi" }, disabledCtx);
    expect(disabledRes.status).toBe("ok");
    expect(text(disabledRes)).toContain("hi");
  });
});

// spec: AC-PERM-10
describe("unsandboxed retry", () => {
  test("retry prompts unless an allow rule matches; strict mode ignores the flag", async () => {
    await ready;
    expect(shDecide("npm test", "default", {}, { sandboxed: false, sandboxAutoAllow: true }).behavior).toBe("ask");
    expect(shDecide("npm test", "default", { allow: ["Bash(npm test *)"] }, { sandboxed: false }).behavior).toBe(
      "allow",
    );
    const cwd = await workspace();
    const tool = createBashTool({ tmpDir: await workspace() });
    const strictCtx: ToolContext = {
      ...context(cwd),
      sandbox: fakeSandboxService("on", "bubblewrap"),
      settings: Settings.parse({
        sandbox: { allowUnsandboxedCommands: false },
      }),
    };
    expect(sandboxedOf(tool, { command: "npm test", dangerouslyDisableSandbox: true }, strictCtx)).toBe(true);
    const looseCtx: ToolContext = {
      ...context(cwd),
      sandbox: fakeSandboxService("on", "bubblewrap"),
      settings: Settings.parse({}),
    };
    expect(sandboxedOf(tool, { command: "npm test", dangerouslyDisableSandbox: true }, looseCtx)).toBe(false);
  });

  test("Bash(dangerouslyDisableSandbox:true) ask rule forces prompt even in bypassPermissions", async () => {
    await ready;
    const cwd = await workspace();
    const tool = createBashTool({ tmpDir: await workspace() });
    const { rules } = ruleSetFromSettings({
      loaded: {
        settings: {},
        rules: {
          allow: [],
          ask: [{ rule: "Bash(dangerouslyDisableSandbox:true)", source: "user", file: "/u/.dovet/settings.json" }],
          deny: [],
        },
        warnings: [],
        notices: [],
        files: [],
      },
      env: {
        os: process.platform as "linux",
        home: "/home/u",
        cwd,
        workingDirs: [cwd],
        canonicalize: (p: string) => p,
        pid: 1,
        ppid: 0,
        selfNames: ["dovet"],
      },
      parsers,
      ruleContext: { os: process.platform as "linux", home: "/home/u", canonicalize: (p: string) => p },
      configDir: "/cfg",
    });
    const bypassCtx: ToolContext = {
      ...context(cwd),
      settings: Settings.parse({}),
      policy: {
        mode: "bypassPermissions",
        rules,
        env: {
          os: process.platform as "linux",
          home: "/home/u",
          cwd,
          workingDirs: [cwd],
          canonicalize: (p: string) => p,
          pid: 1,
          ppid: 0,
          selfNames: ["dovet"],
        },
        parsers,
        sandboxed: true,
      },
      sandbox: fakeSandboxService("on", "bubblewrap"),
    };
    const descNormal = tool.describeAction?.({ command: "ls" }, bypassCtx);
    const descRetry = tool.describeAction?.({ command: "ls", dangerouslyDisableSandbox: true }, bypassCtx);
    if (descNormal?.kind !== "shell" || descRetry?.kind !== "shell") throw new Error("not shell");
    expect(descNormal.unsandboxedRetry).toBe(false);
    expect(descRetry.unsandboxedRetry).toBe(true);

    const st = {
      mode: "bypassPermissions" as const,
      rules,
      env: {
        os: process.platform as "linux",
        home: "/home/u",
        cwd,
        workingDirs: [cwd],
        canonicalize: (p: string) => p,
        pid: 1,
        ppid: 0,
        selfNames: ["dovet"],
      },
    };
    const analysis = analyzeShell(parsers, "bash", "ls", {
      cwd,
      workingDirs: [cwd],
      home: "/home/u",
      glob: expandGlob,
      isDirectory,
    });
    const dNormal = decide(
      {
        tool: "Bash",
        action: { kind: "shell", analysis, sandboxed: descNormal.sandboxed },
        input: { command: "ls", dangerouslyDisableSandbox: descNormal.unsandboxedRetry },
      },
      st,
    );
    const dRetry = decide(
      {
        tool: "Bash",
        action: { kind: "shell", analysis, sandboxed: descRetry.sandboxed },
        input: { command: "ls", dangerouslyDisableSandbox: descRetry.unsandboxedRetry },
      },
      st,
    );
    expect(dNormal.behavior).toBe("allow");
    expect(dRetry.behavior).toBe("ask");
  });
});

// spec: AC-PERM-25
describe("violations reach the model", () => {
  test("a sandboxed curl that exits 0 still reports the blocked host (scripted violations, command-agnostic)", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const tmp = await workspace();
    const base = context(cwd);
    const ctx: ToolContext = {
      ...base,
      env: { PATH: process.env.PATH ?? "", HOME: cwd },
      settings: Settings.parse({}),
      sandbox: fakeSandboxService("on", "bubblewrap", ["blocked host: example.com (denied by sandbox)"]),
      platform: { ...base.platform, shells: () => ({}) },
    };
    const tool = createBashTool({ tmpDir: tmp });
    const prepared = createToolRegistry([tool]).prepare("Bash", { command: "echo ok" });
    if (!prepared.ok) throw new Error(prepared.message);
    const out = await tool.run(prepared.input as never, ctx);
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("ok");
    expect(text(out)).toContain("blocked host: example.com");
    expect(out.meta?.sandboxViolations).toEqual(["blocked host: example.com (denied by sandbox)"]);
  });

  test("an excluded compound command runs sandboxed unless every part matches", async () => {
    const cwd = await workspace();
    const tool = createBashTool({ tmpDir: await workspace() });
    const mk = (excludedCommands: string[]): ToolContext => ({
      ...context(cwd),
      sandbox: fakeSandboxService("on", "bubblewrap"),
      settings: Settings.parse({ sandbox: { excludedCommands } }),
    });
    expect(sandboxedOf(tool, { command: "docker ps && docker images" }, mk(["docker *"]))).toBe(false);
    expect(sandboxedOf(tool, { command: "docker ps && ls" }, mk(["docker *"]))).toBe(true);
  });
});

// spec: AC-PERM-24
describe("sandbox leaves no trace", () => {
  test("after 50 tool-run git commands git status is clean and no lock remains (tool side; sandbox mounts covered by escape suite)", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(join(tmpdir(), "dovet-m201-"));
    const tmp = await mkdtemp(join(tmpdir(), "dovet-m201-tmp-"));
    const git = (args: string[]): void => {
      const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    };
    git(["init", "-q"]);
    git(["config", "user.name", "T"]);
    git(["config", "user.email", "t@example.com"]);
    await writeFile(join(cwd, "a.txt"), "x\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, "hooks"), { recursive: true });
    await writeFile(join(cwd, "hooks", "keep.txt"), "project dir named hooks stays writable\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "hooks dir"]);
    const base = context(cwd);
    const ctx: ToolContext = {
      ...base,
      env: { PATH: process.env.PATH ?? "", HOME: cwd },
      settings: Settings.parse({}),
      sandbox: fakeSandboxService("on", "bubblewrap", [], tmp),
      platform: { ...base.platform, shells: () => ({}) },
    };
    const tool = createBashTool({ tmpDir: tmp });
    for (let i = 0; i < 50; i++) {
      const prepared = createToolRegistry([tool]).prepare("Bash", { command: "git log --oneline -1" });
      if (!prepared.ok) throw new Error(prepared.message);
      const out = await tool.run(prepared.input as never, ctx);
      expect(out.status).toBe("ok");
    }
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd });
    expect(status.stdout.toString()).toBe("");
    const gitDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], { cwd });
    const dotGit = join(cwd, gitDir.stdout.toString().trim());
    const files = await readdir(dotGit).catch(() => [] as string[]);
    expect(files.filter((f) => f.endsWith(".lock"))).toEqual([]);
    expect(await readFile(join(cwd, "hooks", "keep.txt"), "utf8")).toContain("stays writable");
    const { createSandboxService: createSvc } = await import("../policy/index.ts");
    let captured: string[] = [];
    const svc = createSvc({
      os: "linux",
      srtDir: "install/libexec/srt",
      settings: Settings.parse({}),
      workingDirs: [cwd],
      sessionId: "trace-test",
      configDir: "/cfg",
      dataDir: "/data",
      home: cwd,
      starter: (async (o: { denyWrite?: string[] }) => {
        captured = o.denyWrite ?? [];
        return {
          checkDependencies: () => ({ errors: [], warnings: [] }),
          getLinuxGlobPatternWarnings: () => [],
          getSandboxViolationStore: () => ({ getViolations: () => [] }),
          wrapWithSandbox: async (c: string) => c,
          cleanupAfterCommand: () => {},
        };
      }) as never,
    });
    await svc.ready;
    expect(captured).toContain(px(join(cwd, ".git", "hooks")));
    expect(captured).toContain(px(join(cwd, ".git", "config")));
  }, 60_000); // 50 real git runs through the Bash tool take over 5 s on macOS CI runners

  test("in a repo with extensions.worktreeConfig git log works and the common dir stays protected", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(join(tmpdir(), "dovet-m201-wt-"));
    const tmp = await mkdtemp(join(tmpdir(), "dovet-m201-wt-tmp-"));
    const git = (args: string[], dir = cwd): void => {
      const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    };
    git(["init", "-q"]);
    git(["config", "user.name", "T"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "extensions.worktreeConfig", "true"]);
    await writeFile(join(cwd, "a.txt"), "x\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    const linked = join(tmp, "linked");
    git(["worktree", "add", linked]);
    const commonOut = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: linked,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    const { resolve: resolvePath } = await import("node:path");
    const common = resolvePath(linked, commonOut.stdout.toString().trim());
    const { realpathSync } = await import("node:fs");
    const realCommon = realpathSync(common);
    const linkedCtxBase = context(linked);
    const linkedCtx: ToolContext = {
      ...linkedCtxBase,
      env: { PATH: process.env.PATH ?? "", HOME: cwd },
      settings: Settings.parse({}),
      sandbox: fakeSandboxService("on", "bubblewrap", [], tmp),
      platform: { ...linkedCtxBase.platform, shells: () => ({}) },
    };
    const tool = createBashTool({ tmpDir: tmp });
    const prepared = createToolRegistry([tool]).prepare("Bash", { command: "git log --oneline -1" });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(
      (
        await tool.run(prepared.input as never, {
          ...linkedCtx,
          session: { ...linkedCtx.session, cwd: linked as never, workingDirs: [linked as never] },
        })
      ).status,
    ).toBe("ok");
    let captured: { denyWrite?: string[] } = {};
    const { createSandboxService } = await import("../policy/index.ts");
    const svc = createSandboxService({
      os: "linux",
      srtDir: "install/libexec/srt",
      settings: Settings.parse({}),
      workingDirs: [linked],
      sessionId: "worktree-test",
      configDir: "/cfg",
      dataDir: "/data",
      home: cwd,
      starter: (async (o: { denyWrite?: string[] }) => {
        captured = o.denyWrite === undefined ? {} : { denyWrite: o.denyWrite };
        return {
          checkDependencies: () => ({ errors: [], warnings: [] }),
          getLinuxGlobPatternWarnings: () => [],
          getSandboxViolationStore: () => ({ getViolations: () => [] }),
          wrapWithSandbox: async (c: string) => c,
          cleanupAfterCommand: () => {},
        };
      }) as never,
    });
    await svc.ready;
    expect(svc.state).toBe("on");
    expect(captured.denyWrite ?? []).toContain(px(join(realCommon, "hooks")));
    expect(captured.denyWrite ?? []).toContain(px(join(realCommon, "config")));
  });
});

// spec: AC-PERM-28
describe("boundary", () => {
  test("clone runs free while push, publish and pr create name the remote-action boundary", async () => {
    await ready;
    const healthy = { sandboxed: true, sandboxAutoAllow: true };
    expect(shDecide("git clone https://github.com/o/r", "default", {}, healthy).behavior).toBe("allow");
    for (const cmd of ["git push", "git -C . push", "npm publish", "gh pr create"]) {
      const d = shDecide(cmd, "default", {}, healthy);
      expect(d.behavior).toBe("ask");
      expect(d.reason).toContain("remote action");
    }
  });

  test("without a sandbox npm test asks and the status says judged by text", async () => {
    await ready;
    expect(shDecide("npm test", "default", {}, { sandboxed: false, sandboxAutoAllow: true }).behavior).toBe("ask");
    expect(sandboxStatus("off", "none")).toContain("judged by text");
  });
});
