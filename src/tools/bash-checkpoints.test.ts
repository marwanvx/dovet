// The real Bash, Write and Edit tools with the checkpoint service behind them (docs/specs/checkpoints.md).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPlatformCore } from "../platform/index.ts";
import { type AbsPath, CheckpointData, type EventEnvelope, Settings } from "../schema/index.ts";
import { type CheckpointService, createBlobStore, openCheckpoints } from "../store/index.ts";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createToolRegistry,
  createWriteTool,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
} from "./index.ts";
import { context, text, workspace } from "./test-context.ts";

const BASH = Bun.which("bash") as AbsPath;

const gitIn = (cwd: string, ...args: string[]): void => {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

interface Rig {
  cwd: string;
  tmp: string;
  svc: CheckpointService;
  events: CheckpointData[];
  ctx: ToolContext;
  run: (tool: ToolDefinition<never>, name: string, input: Record<string, unknown>) => Promise<ToolOutput>;
  log: () => EventEnvelope[];
}

async function rig(inGit: boolean): Promise<Rig> {
  const cwd = await workspace();
  const data = await workspace();
  await writeFile(join(cwd, "a.txt"), "alpha\nbeta\n");
  await writeFile(join(cwd, "b.txt"), "bee\n");
  if (inGit) {
    gitIn(cwd, "init", "-q");
    gitIn(cwd, "add", ".");
    gitIn(cwd, "commit", "-q", "-m", "init");
  }
  const env = { PATH: process.env.PATH ?? "", HOME: data, SHELL: BASH };
  const events: CheckpointData[] = [];
  const svc = await openCheckpoints({
    workspace: cwd,
    projectDir: join(data, "project"),
    session: "s",
    env,
    platform: process.platform,
    blobs: createBlobStore(data),
    enabled: true,
    record: (e) => events.push(CheckpointData.parse(e)),
  });
  svc.beginTurn(1);
  const base = context(cwd);
  const core = createPlatformCore({
    os: process.platform as "linux",
    arch: process.arch,
    execPath: process.execPath,
    env,
    projectRoot: cwd as AbsPath,
    kill: (pid, signal) => process.kill(pid, signal),
  });
  const ctx: ToolContext = {
    ...base,
    env,
    settings: Settings.parse({}),
    platform: { ...base.platform, ...core },
    recordWrite: (path, before) => svc.recordWrite(path, before),
    ...(svc.shell === undefined ? {} : { snapshots: svc.shell }),
    shellNotice: () => svc.shellNotice(),
  };
  const run: Rig["run"] = async (tool, name, input) => {
    const prepared = createToolRegistry([tool as ToolDefinition<unknown>]).prepare(name, input);
    if (!prepared.ok) throw new Error(prepared.message);
    return tool.run(prepared.input as never, ctx);
  };
  return {
    cwd,
    tmp: join(data, "bash-tmp"),
    svc,
    events,
    ctx,
    run,
    log: () => events.map((e) => ({ type: "checkpoint", data: e }) as EventEnvelope),
  };
}

const bashTool = (r: Rig): ToolDefinition<never> => createBashTool({ tmpDir: r.tmp }) as never;

describe.skipIf(process.platform === "win32")("checkpoints behind the tools", () => {
  // spec: AC-CKPT-01
  test("git workspace: a shell command that edits in place, removes a file and creates one is undone by the rewind", async () => {
    const r = await rig(true);
    const out = await r.run(bashTool(r), "Bash", {
      command: "sed -i.bak 's/alpha/ALPHA/' a.txt && rm -f a.txt.bak b.txt && echo made > c.txt",
    });
    expect(out.status).toBe("ok");
    expect(readFileSync(join(r.cwd, "a.txt"), "utf8")).toBe("ALPHA\nbeta\n");
    expect(existsSync(join(r.cwd, "b.txt"))).toBe(false);
    expect(r.events.map((e) => `${e.id}:${e.mechanism}`)).toEqual(["c1:git-tree"]);

    const result = await r.svc.restore(r.log(), "c1");
    expect(result.failed).toEqual([]);
    expect(readFileSync(join(r.cwd, "a.txt"), "utf8")).toBe("alpha\nbeta\n");
    expect(readFileSync(join(r.cwd, "b.txt"), "utf8")).toBe("bee\n");
    expect(existsSync(join(r.cwd, "c.txt"))).toBe(false);
  });

  // spec: AC-CKPT-06
  test("outside git: Edit and Write rewind through the blobs, and a shell change is reported as not restorable", async () => {
    const r = await rig(false);
    expect(r.ctx.snapshots).toBeUndefined();
    await r.run(createReadTool() as never, "Read", { file_path: join(r.cwd, "a.txt") });
    await r.run(createReadTool() as never, "Read", { file_path: join(r.cwd, "b.txt") });
    expect(
      (
        await r.run(createEditTool() as never, "Edit", {
          file_path: join(r.cwd, "a.txt"),
          old_string: "alpha",
          new_string: "ALPHA",
        })
      ).status,
    ).toBe("ok");
    expect(
      (await r.run(createWriteTool() as never, "Write", { file_path: join(r.cwd, "b.txt"), content: "rewritten\n" }))
        .status,
    ).toBe("ok");
    expect(
      (await r.run(createWriteTool() as never, "Write", { file_path: join(r.cwd, "new.txt"), content: "fresh\n" }))
        .status,
    ).toBe("ok");

    const shell = await r.run(bashTool(r), "Bash", { command: "echo shell > shell.txt" });
    expect(text(shell)).toContain("can't be undone");
    expect(shell.meta?.fileChanges).toBeUndefined();

    await r.svc.restore(r.log(), "c1");
    expect(readFileSync(join(r.cwd, "a.txt"), "utf8")).toBe("alpha\nbeta\n");
    expect(readFileSync(join(r.cwd, "b.txt"), "utf8")).toBe("bee\n");
    expect(existsSync(join(r.cwd, "new.txt"))).toBe(false);
    expect(readFileSync(join(r.cwd, "shell.txt"), "utf8")).toBe("shell\n");
  });
});
