// Tools use the decision (M1-23c): effects from effectsOf, the silent read, keepHardLink.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { link, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempProject } from "../../test/helpers/index.ts";
import type { Os } from "../platform/index.ts";
import { canonicalizePath } from "../platform/index.ts";
import type { Env, State } from "../policy/index.ts";
import {
  analyzeShell,
  decide,
  effectsOf,
  expandGlob,
  isDirectory,
  loadRules,
  loadShellParsers,
  type RuleSet,
  type ShellParsers,
} from "../policy/index.ts";
import type { AbsPath } from "../schema/index.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool } from "./read.ts";
import { context, text, workspace } from "./test-context.ts";
import type { ToolPolicyState } from "./types.ts";
import { createWriteTool } from "./write.ts";

let parsers: ShellParsers;
let root = "";
let dispose: () => Promise<void>;
beforeAll(async () => {
  parsers = await loadShellParsers();
  const project = await tempProject({ "a.ts": "a\n", ".env": "K=1\n", "src/x.ts": "x\n" });
  root = project.root;
  dispose = project.dispose;
});
afterAll(() => dispose());

const os = process.platform as Os;
const envFor = (cwd: string): Env => ({
  os,
  home: join(root, "..", "home"),
  cwd,
  workingDirs: [cwd],
  canonicalize: (p) => canonicalizePath(p, cwd, os),
  pid: 4242,
  ppid: 4241,
  selfNames: ["dovet", "bun"],
});
const rulesFor = (allow: string[] = [], deny: string[] = []): RuleSet =>
  loadRules(
    [
      {
        file: "/p/s.json",
        baseDir: root,
        allow: allow.map((text) => ({ text })),
        deny: deny.map((text) => ({ text })),
      },
    ],
    { os, home: "/home/u", canonicalize: (p) => p },
  ).rules;
const policyFor = (cwd: string, allow: string[] = [], deny: string[] = []): ToolPolicyState => ({
  rules: rulesFor(allow, deny),
  mode: "default",
  env: envFor(cwd),
  parsers,
  sandboxed: false,
  sandboxAutoAllow: false,
});

describe("describeAction effects come from effectsOf", () => {
  // spec: AC-PERM-14
  test("Read inside lists no writes; a sensitive read lists the file", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.ts"), "a\n");
    await writeFile(join(cwd, ".env"), "K=1\n");
    const ctx = context(cwd, { policy: policyFor(cwd) });
    const read = createReadTool();
    const inside = read.describeAction({ file_path: "a.ts" }, ctx);
    expect(inside.effects).toMatchObject({ writes: "none", network: "none" });
    const sensitive = read.describeAction({ file_path: ".env" }, ctx);
    expect(sensitive.effects.sensitiveReads).toEqual([join(cwd, ".env") as AbsPath]);
    const st: State = { mode: "default", rules: rulesFor(), env: envFor(cwd) };
    const req = { tool: "Read", action: { kind: "read" as const, paths: [join(cwd, ".env")] } };
    expect(sensitive.effects).toEqual(effectsOf(req, decide(req, st), false));
  });

  // spec: AC-PERM-14
  test("Edit inside is workspace, outside is outside, .git is protected", async () => {
    const cwd = await workspace();
    const ctx = context(cwd, { policy: policyFor(cwd) });
    const edit = createEditTool();
    expect(edit.describeAction({ file_path: "a.ts", old_string: "x", new_string: "y" }, ctx).effects.writes).toBe(
      "workspace",
    );
    const st: State = { mode: "default", rules: rulesFor(), env: envFor(cwd) };
    for (const [file, writes] of [
      ["a.ts", "workspace"],
      ["../outside.txt", "outside"],
      [".git/config", "protected"],
    ] as const) {
      const abs = join(cwd, file);
      const req = { tool: "Edit", action: { kind: "edit" as const, paths: [abs] } };
      expect(edit.describeAction({ file_path: file, old_string: "x", new_string: "y" }, ctx).effects).toEqual(
        effectsOf(req, decide(req, st), false),
      );
      expect(edit.describeAction({ file_path: file, old_string: "x", new_string: "y" }, ctx).effects.writes).toBe(
        writes,
      );
    }
  });

  // spec: AC-PERM-14
  test("Bash read-only has no effects; otherwise unknown unsandboxed, workspace sandboxed", async () => {
    const cwd = await workspace();
    const unsandboxed = context(cwd, { policy: { ...policyFor(cwd), parsers, sandboxed: false } });
    const sandboxed = context(cwd, { policy: { ...policyFor(cwd), parsers, sandboxed: true, sandboxAutoAllow: true } });
    const bash = createBashTool({ tmpDir: join(cwd, "tmp") });
    expect(bash.describeAction({ command: "ls" }, unsandboxed).effects).toMatchObject({
      writes: "none",
      network: "none",
    });
    const st: State = { mode: "default", rules: rulesFor(), env: envFor(cwd) };
    const req = {
      tool: "Bash",
      action: {
        kind: "shell" as const,
        sandboxed: false,
        analysis: analyzeShell(parsers, "bash", "npm run build", {
          cwd,
          workingDirs: [cwd],
          home: join(cwd, "..", "home"),
          glob: expandGlob,
          isDirectory,
        }),
      },
    };
    expect(bash.describeAction({ command: "npm run build" }, unsandboxed).effects).toEqual(
      effectsOf(req, decide(req, st), false),
    );
    expect(bash.describeAction({ command: "npm run build" }, unsandboxed).effects.writes).toBe("unknown");
    expect(bash.describeAction({ command: "npm run build" }, sandboxed).effects.writes).toBe("workspace");
  });
});

describe("silent read and hard links", () => {
  // spec: AC-PERM-14
  test("Write to an unread file succeeds when it could be read without asking", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "old\n");
    const ctx = context(cwd, { policy: policyFor(cwd) });
    const write = createWriteTool();
    const prepared = (await import("./registry.ts")).createToolRegistry([write as never]).prepare("Write", {
      file_path: "a.txt",
      content: "new\n",
    });
    if (!prepared.ok) throw new Error(prepared.message);
    const out = await write.run(prepared.input as never, ctx);
    expect(out.status).toBe("ok");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("new\n");
  });

  // spec: AC-PERM-14
  test("Write to an unread sensitive file still needs a Read first", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, ".env"), "K=1\n");
    const ctx = context(cwd, { policy: policyFor(cwd) });
    const write = createWriteTool();
    const { createToolRegistry } = await import("./registry.ts");
    const prepared = createToolRegistry([write as never]).prepare("Write", {
      file_path: ".env",
      content: "K=2\n",
    });
    if (!prepared.ok) throw new Error(prepared.message);
    const out = await write.run(prepared.input as never, ctx);
    expect(out.status).toBe("error");
    expect(text(out)).toContain("You must Read");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("K=1\n");
  });

  // spec: AC-PERM-14
  test("Edit to an unread file succeeds when it could be read without asking", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "hello\n");
    const ctx = context(cwd, { policy: policyFor(cwd) });
    const edit = createEditTool();
    const { createToolRegistry } = await import("./registry.ts");
    const prepared = createToolRegistry([edit as never]).prepare("Edit", {
      file_path: "a.txt",
      old_string: "hello",
      new_string: "hi",
    });
    if (!prepared.ok) throw new Error(prepared.message);
    expect((await edit.run(prepared.input as never, ctx)).status).toBe("ok");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("hi\n");
  });

  // spec: AC-PERM-14
  test("keepHardLink keeps the link; without it the other name keeps the old content", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    await writeFile(join(cwd, "one"), "old\n");
    await link(join(cwd, "one"), join(cwd, "two"));
    const { createToolRegistry } = await import("./registry.ts");
    const write = createWriteTool();
    const runWrite = async (keepHardLink?: boolean) => {
      const ctx = context(cwd, { policy: policyFor(cwd), ...(keepHardLink === true ? { keepHardLink: true } : {}) });
      const prepared = createToolRegistry([write as never]).prepare("Write", {
        file_path: "one",
        content: "new\n",
      });
      if (!prepared.ok) throw new Error(prepared.message);
      return write.run(prepared.input as never, ctx);
    };
    await writeFile(join(cwd, "one"), "old\n");
    const kept = await runWrite(true);
    expect(kept.status).toBe("ok");
    expect(await readFile(join(cwd, "two"), "utf8")).toBe("new\n");
    await writeFile(join(cwd, "two"), "old\n");
    const ctx2 = context(cwd, { policy: policyFor(cwd) });
    const read = createReadTool();
    const { createToolRegistry: registry2 } = await import("./registry.ts");
    const rp = registry2([read as never]).prepare("Read", { file_path: "one" });
    if (!rp.ok) throw new Error(rp.message);
    await read.run(rp.input as never, ctx2);
    const replaced = await runWrite(undefined);
    expect(text(replaced)).toContain("hard links");
    expect(await readFile(join(cwd, "two"), "utf8")).toBe("old\n");
  });

  // spec: AC-PERM-14
  test("Edit with keepHardLink keeps the link", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    await writeFile(join(cwd, "e1"), "old\n");
    await link(join(cwd, "e1"), join(cwd, "e2"));
    const { createToolRegistry } = await import("./registry.ts");
    const edit = createEditTool();
    const ctx = context(cwd, { policy: policyFor(cwd), keepHardLink: true });
    const prepared = createToolRegistry([edit as never]).prepare("Edit", {
      file_path: "e1",
      old_string: "old",
      new_string: "new",
    });
    if (!prepared.ok) throw new Error(prepared.message);
    expect((await edit.run(prepared.input as never, ctx)).status).toBe("ok");
    expect(await readFile(join(cwd, "e2"), "utf8")).toBe("new\n");
  });
});
