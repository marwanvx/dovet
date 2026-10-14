import { describe, expect, test } from "bun:test";
import type { AbsPath } from "../schema/index.ts";
import { resolveShell, type ShellDeps } from "./shell.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

function deps(over: {
  os?: ShellDeps["os"];
  files?: string[];
  programs?: Record<string, string>;
  env?: Record<string, string>;
  gitExecPath?: string;
}): ShellDeps {
  const files = new Set(over.files ?? []);
  return {
    os: over.os ?? "win32",
    env: over.env ?? { ProgramFiles: "C:\\Program Files", LocalAppData: "C:\\Users\\x\\AppData\\Local" },
    resolve: async (program) => over.programs?.[program] as AbsPath | undefined,
    exists: async (path) => files.has(path),
    gitExecPath: async () => over.gitExecPath,
  };
}

describe("resolveShell", () => {
  // spec: AC-PLAT-01
  test("Windows prefers Git Bash, then pwsh, then Windows PowerShell 5.1", async () => {
    const programs = { pwsh: "C:\\pwsh\\pwsh.exe", powershell: "C:\\ps\\powershell.exe" };
    expect(await resolveShell(deps({ files: [GIT_BASH], programs }))).toEqual({ kind: "git-bash", path: GIT_BASH });
    expect(await resolveShell(deps({ programs }))).toEqual({
      kind: "powershell",
      path: programs.pwsh,
      edition: "pwsh",
    });
    expect(await resolveShell(deps({ programs: { powershell: programs.powershell } }))).toEqual({
      kind: "powershell",
      path: programs.powershell,
      edition: "windows",
    });
    expect(await resolveShell(deps({}))).toBeUndefined();
  });

  // spec: AC-PLAT-01
  test("Git Bash is looked for in DOVET_GIT_BASH_PATH, git --exec-path, then the install folders", async () => {
    const custom = "D:\\tools\\Git\\bin\\bash.exe";
    const env = { DOVET_GIT_BASH_PATH: custom, ProgramFiles: "C:\\Program Files" };
    expect((await resolveShell(deps({ env, files: [custom, GIT_BASH] })))?.path).toBe(custom);

    const fromGit = await resolveShell(
      deps({
        files: ["E:\\Git\\bin\\bash.exe"],
        gitExecPath: "E:\\Git\\mingw64\\libexec\\git-core",
      }),
    );
    expect(fromGit?.path).toBe("E:\\Git\\bin\\bash.exe");

    const local = "C:\\Users\\x\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect((await resolveShell(deps({ files: [local] })))?.path).toBe(local);
  });

  // spec: AC-PLAT-01
  test("WSL's launcher in System32 is never taken for Git Bash", async () => {
    const wsl = "C:\\Windows\\System32\\bash.exe";
    const env = { DOVET_GIT_BASH_PATH: wsl };
    const found = await resolveShell(deps({ env, files: [wsl], programs: { powershell: "C:\\ps\\powershell.exe" } }));
    expect(found?.kind).toBe("powershell");
    for (const other of ["C:/Windows/System32/bash.exe", "C:\\Windows\\Sysnative\\bash.exe"]) {
      const via = await resolveShell(
        deps({
          env: { DOVET_GIT_BASH_PATH: other },
          files: [other],
          programs: { powershell: "C:\\ps\\powershell.exe" },
        }),
      );
      expect(via?.kind).toBe("powershell");
    }
  });

  // spec: AC-PLAT-01
  test("shell.windows chooses; a missing Git Bash falls back to PowerShell with a note", async () => {
    const programs = { pwsh: "C:\\pwsh\\pwsh.exe" };
    expect((await resolveShell(deps({ files: [GIT_BASH], programs }), { windows: "powershell" }))?.kind).toBe(
      "powershell",
    );
    const forced = await resolveShell(deps({ programs }), { windows: "git-bash" });
    expect(forced?.kind).toBe("powershell");
    expect(forced?.note).toContain("Git Bash was not found");
    expect((await resolveShell(deps({ programs }), { windows: "auto" }))?.note).toBeUndefined();
    const configured = "F:\\G\\bin\\bash.exe";
    expect((await resolveShell(deps({ files: [configured] }), { gitBashPath: configured }))?.path).toBe(configured);
  });

  // spec: AC-PLAT-01
  test("on Linux and macOS it is the bash on PATH, never PowerShell", async () => {
    const programs = { bash: "/usr/bin/bash", pwsh: "/usr/bin/pwsh" };
    for (const os of ["linux", "darwin"] as const) {
      expect(await resolveShell(deps({ os, programs }), { windows: "powershell" })).toEqual({
        kind: "bash",
        path: "/usr/bin/bash",
      });
      expect(await resolveShell(deps({ os }))).toBeUndefined();
    }
  });
});
