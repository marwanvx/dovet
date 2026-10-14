import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlatformCore } from "../platform/index.ts";
import { type AbsPath, Settings } from "../schema/index.ts";
import { createBashTool } from "./bash.ts";
import { createToolRegistry, type ToolContext, type ToolOutput } from "./index.ts";
import type { Edition } from "./powershell-script.ts";
import { powershellArgv, powershellScript } from "./powershell-script.ts";
import { context, text, workspace } from "./test-context.ts";

const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

type Rig = { cwd: string; tmp: string; ctx: ToolContext; argvs: string[][] };

async function rig(settings: Record<string, unknown> = {}): Promise<Rig> {
  const cwd = await workspace();
  const tmp = await workspace();
  const core = createPlatformCore({
    os: process.platform as "linux",
    arch: process.arch,
    execPath: process.execPath,
    env,
    projectRoot: cwd as AbsPath,
    kill: (pid, signal) => process.kill(pid, signal),
    termGraceMs: 300,
  });
  const argvs: string[][] = [];
  const base = context(cwd);
  const ctx: ToolContext = {
    ...base,
    env,
    settings: Settings.parse(settings),
    platform: {
      ...base.platform,
      ...core,
      spawn: (cmd) => {
        argvs.push(cmd.argv);
        return core.spawn(cmd);
      },
    },
  };
  return { cwd, tmp, ctx, argvs };
}

async function ps(
  r: Rig,
  input: Record<string, unknown>,
  powershell: { edition: Edition; viaCommand?: boolean },
  tool = createBashTool({ tmpDir: r.tmp, powershell }),
): Promise<ToolOutput> {
  const prepared = createToolRegistry([tool]).prepare("PowerShell", input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, r.ctx);
}

describe("PowerShell script and arguments", () => {
  const base = { command: "Get-ChildItem", cwd: "C:\\Users\\o'brien\\proj", cwdFile: "C:\\t\\ps\\ab12cd34.cwd" };

  // spec: AC-TOOLS-28
  test("the wrapper sets UTF-8, quiet progress, the cwd and the cwd capture, and quotes paths safely", () => {
    const script = powershellScript({ ...base, edition: "pwsh" });
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(script).toContain("[Console]::OutputEncoding");
    expect(script).toContain("$PSStyle.OutputRendering = 'PlainText'");
    expect(script).not.toContain("Out-File:Encoding");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\Users\\o''brien\\proj'");
    expect(script).toMatch(/try \{\nGet-ChildItem\n[\s\S]*\} finally \{[\s\S]*ab12cd34\.cwd/);
    expect(powershellScript({ ...base, cwd: "C:\\a‘b", edition: "pwsh" })).toContain("'C:\\a‘‘b'");
  });

  // spec: AC-TOOLS-28
  test("5.1 redirects with utf8 instead of UTF-16 and has no PSStyle", () => {
    const script = powershellScript({ ...base, edition: "windows" });
    expect(script).toContain("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'");
    expect(script).not.toContain("PSStyle");
  });

  // spec: AC-TOOLS-28
  test("the command is passed as a script file, or as -Command after a policy refusal, never -EncodedCommand", () => {
    const file = powershellArgv({ exe: "pwsh", scriptPath: "C:\\t\\a.ps1", scriptText: "x", viaCommand: false });
    expect(file.join(" ")).toBe("pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\t\\a.ps1");
    const command = powershellArgv({ exe: "pwsh", scriptPath: "C:\\t\\a.ps1", scriptText: "x y", viaCommand: true });
    expect(command).toEqual(["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "x y"]);
  });
});

describe.skipIf(process.platform === "win32")("PowerShell with a stand-in executable", () => {
  async function fake(r: Rig, body: string): Promise<string> {
    const path = join(r.tmp, "fakeps");
    await writeFile(path, `#!/bin/sh\necho "$4" >> "${r.tmp}/calls.log"\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  // spec: AC-TOOLS-28
  test("Group Policy refusing -File switches to -Command for the rest of the session", async () => {
    const r = await rig();
    r.ctx.settings = Settings.parse({ shell: { path: await fake(r, REFUSE_FILE) } });
    const tool = createBashTool({ tmpDir: r.tmp, powershell: { edition: "windows" } });
    const first = await ps(r, { command: "Write-Output hi" }, { edition: "windows" }, tool);
    expect(first.status).toBe("ok");
    expect(text(first)).toContain("via command");
    expect(text(first)).toContain("Group Policy enforces a PowerShell execution policy");
    const second = await ps(r, { command: "Write-Output hi" }, { edition: "windows" }, tool);
    expect(text(second)).toBe("via command");
    const calls = (await readFile(join(r.tmp, "calls.log"), "utf8")).trim().split("\n");
    expect(calls).toEqual(["-ExecutionPolicy", "-Command", "-Command"]);
    expect(r.argvs.flat()).not.toContain("-EncodedCommand");
  });

  // spec: AC-TOOLS-28
  test("the script file is UTF-8 with a BOM and lives under ps/ with a short name", async () => {
    const r = await rig();
    r.ctx.settings = Settings.parse({
      shell: { path: await fake(r, 'for a; do f=$a; done; head -c 3 "$f" | od -An -tx1; echo "$f"') },
    });
    const out = await ps(r, { command: "Write-Output 'héllo'" }, { edition: "pwsh" });
    const [bom, path] = text(out).split("\n");
    expect(bom?.trim().split(/\s+/).join(" ")).toBe("ef bb bf");
    expect(path).toMatch(/\/ps\/[0-9a-f]{8}\.ps1$/);
  });

  test("the tool is named PowerShell and its description file follows the edition", () => {
    const pwsh = createBashTool({ tmpDir: "/t", powershell: { edition: "pwsh" } });
    const old = createBashTool({ tmpDir: "/t", powershell: { edition: "windows" } });
    expect([pwsh.name, pwsh.descriptionFile]).toEqual(["PowerShell", "tools/PowerShell.md"]);
    expect(old.descriptionFile).toBe("tools/PowerShell51.md");
    expect(createBashTool({ tmpDir: "/t" }).name).toBe("Bash");
  });
});

const REFUSE_FILE = `case " $* " in *" -File "*) echo "File a.ps1 cannot be loaded because running scripts is disabled on this system."; exit 1;; esac
echo "via command"`;

const exit3 = process.platform === "win32" ? "cmd /c exit 3" : "sh -c 'exit 3'";
const exit2 = process.platform === "win32" ? "cmd /c exit 2" : "sh -c 'exit 2'";

const editions: Array<[string, Edition]> = [];
if (Bun.which("pwsh") !== null) editions.push(["pwsh", "pwsh"]);
if (process.platform === "win32" && Bun.which("powershell") !== null) editions.push(["powershell", "windows"]);

describe.each(editions)("real %s", (_name, edition) => {
  // spec: AC-TOOLS-28
  test("non-ASCII text and embedded quotes round-trip", async () => {
    const r = await rig();
    const out = await ps(r, { command: `Write-Output 'héllo "你好" it''s'` }, { edition });
    expect(out.status).toBe("ok");
    expect(text(out)).toBe(`héllo "你好" it's`);
  });

  // spec: AC-PLAT-04
  test("native programs' non-ASCII output round-trips", async () => {
    const r = await rig();
    const out = await ps(r, { command: `git --version; python -c "print('héllo 你好')"` }, { edition });
    expect(text(out)).toContain("héllo 你好");
  });

  // spec: AC-TOOLS-28
  test("a native exit code is returned; a failing cmdlet returns 1; a later success wins", async () => {
    const r = await rig();
    const native = await ps(r, { command: exit3 }, { edition });
    expect(native.status).toBe("error");
    expect(native.meta?.exitCode).toBe(3);
    const cmdlet = await ps(r, { command: "Get-Item -LiteralPath ./does-not-exist" }, { edition });
    expect(cmdlet.meta?.exitCode).toBe(1);
    const mixed = await ps(r, { command: `${exit3}; Get-Location` }, { edition });
    expect(mixed.meta?.exitCode).toBe(0);
    expect((await ps(r, { command: "Write-Output ok" }, { edition })).meta?.exitCode).toBe(0);
  });

  // spec: AC-TOOLS-28
  test("cd carries over, also when the command calls exit", async () => {
    const r = await rig();
    await mkdir(join(r.cwd, "sub"));
    const out = await ps(r, { command: "cd sub" }, { edition });
    expect(out.meta?.effects).toEqual([{ kind: "cwd", path: join(r.cwd, "sub") }]);
    const quit = await ps(r, { command: "cd sub; exit 4" }, { edition });
    expect(quit.meta?.exitCode).toBe(4);
    expect(quit.meta?.effects).toEqual([{ kind: "cwd", path: join(r.cwd, "sub") }]);
  });

  // spec: AC-TOOLS-28
  test("-Command mode runs the same commands and spawns no -EncodedCommand", async () => {
    const r = await rig();
    const out = await ps(r, { command: `Write-Output 'héllo'; ${exit2}` }, { edition, viaCommand: true });
    expect(text(out)).toContain("héllo");
    expect(out.meta?.exitCode).toBe(2);
    expect(r.argvs.flat()).toContain("-Command");
    expect(r.argvs.flat()).not.toContain("-EncodedCommand");
  });
});
