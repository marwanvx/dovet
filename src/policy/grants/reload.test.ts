import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TempProject, tempProject } from "../../../test/helpers/index.ts";
import { canonicalizePath, type Os } from "../../platform/index.ts";
import { pollSettings, snapshotSettings } from "../../store/index.ts";
import { decide, type Env, type Request } from "../decide/index.ts";
import { loadShellParsers, type ShellParsers } from "../shell-parse/load.ts";
import { ruleSetFromSettings } from "./index.ts";

let parsers: ShellParsers;
const open: TempProject[] = [];
beforeAll(async () => {
  parsers = await loadShellParsers();
});
afterAll(async () => {
  await Promise.all(open.splice(0).map((p) => p.dispose()));
});

const os = process.platform as Os;
function envFor(root: string): Env {
  return {
    os,
    home: join(root, "..", "home"),
    cwd: root,
    workingDirs: [root],
    canonicalize: (p) => canonicalizePath(p, root, os),
    pid: 4242,
    ppid: 4241,
    selfNames: ["dovet", "bun"],
  };
}
function ctxFor(root: string) {
  const env = envFor(root);
  return {
    env,
    parsers,
    ruleContext: { os, home: env.home, canonicalize: env.canonicalize },
    configDir: join(root, "cfg"),
  };
}
function readReq(path: string): Request {
  return { tool: "Read", action: { kind: "read", paths: [path] } };
}

describe("live reload through the decision", () => {
  // spec: AC-PERM-19
  test("adding a deny rule mid-session blocks the next call; removing it unblocks", async () => {
    const dir = await tempProject({ "proj/.dovet/settings.local.json": '{ "permissions": { "deny": [] } }' });
    open.push(dir);
    const proj = join(dir.root, "proj");
    const input = {
      dirs: { config: join(dir.root, "cfg") },
      home: join(dir.root, "home"),
      projectRoot: proj,
      env: {},
    };
    const target = join(proj, "notes.txt");
    const prev = await snapshotSettings(input);
    const ctx = { ...ctxFor(proj), configDir: join(dir.root, "cfg"), env: envFor(proj) };
    const before = ruleSetFromSettings({ ...ctx, loaded: prev.loaded });
    expect(decide(readReq(target), { mode: "default", rules: before.rules, env: envFor(proj) }).behavior).not.toBe(
      "deny",
    );

    await writeFile(join(proj, ".dovet", "settings.local.json"), '{ "permissions": { "deny": ["Read(/notes.txt)"] } }');
    const next = await pollSettings(prev, input);
    expect(next.changed).toBe(true);
    const after = ruleSetFromSettings({ ...ctx, loaded: next.loaded });
    expect(decide(readReq(target), { mode: "default", rules: after.rules, env: envFor(proj) }).behavior).toBe("deny");

    await writeFile(join(proj, ".dovet", "settings.local.json"), '{ "permissions": { "deny": [] } }');
    const third = await pollSettings(next.snapshot, input);
    expect(third.changed).toBe(true);
    const restored = ruleSetFromSettings({ ...ctx, loaded: third.loaded });
    expect(decide(readReq(target), { mode: "default", rules: restored.rules, env: envFor(proj) }).behavior).not.toBe(
      "deny",
    );
  });

  // spec: AC-PERM-19
  test("an invalid edit keeps the previous rules with a warning", async () => {
    const dir = await tempProject({ "proj/.dovet/settings.local.json": '{ "permissions": { "deny": [] } }' });
    open.push(dir);
    const input = {
      dirs: { config: join(dir.root, "cfg") },
      home: join(dir.root, "home"),
      projectRoot: join(dir.root, "proj"),
      env: {},
    };
    const prev = await snapshotSettings(input);
    const before = ruleSetFromSettings({ ...ctxFor(dir.root), loaded: prev.loaded }).rules.list;
    await writeFile(
      join(dir.root, "proj", ".dovet", "settings.local.json"),
      '{\n "permissions": { "deny": ["Bash(ls) x"] }\n}',
    );
    const next = await pollSettings(prev, input);
    expect(next.loaded.settings.permissions?.deny ?? []).toEqual([]);
    expect(next.warnings.length).toBeGreaterThan(0);
    const kept = ruleSetFromSettings({ ...ctxFor(dir.root), loaded: next.loaded });
    expect(kept.rules.list).toEqual(before);
  });

  // spec: AC-PERM-19
  test("creating settings.json after startup is picked up and recompiles", async () => {
    const dir = await tempProject({});
    open.push(dir);
    const input = {
      dirs: { config: join(dir.root, "cfg") },
      home: join(dir.root, "home"),
      projectRoot: join(dir.root, "proj"),
      env: {},
    };
    const prev = await snapshotSettings(input);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir.root, "proj", ".dovet"), { recursive: true });
    await writeFile(join(dir.root, "proj", ".dovet", "settings.json"), '{ "permissions": { "deny": ["WebFetch"] } }');
    const next = await pollSettings(prev, input);
    expect(next.changed).toBe(true);
    const compiled = ruleSetFromSettings({ ...ctxFor(dir.root), loaded: next.loaded });
    expect(compiled.rules.list.map((r) => r.raw)).toContain("WebFetch");
  });

  // spec: AC-PERM-19
  test("a recompiled rule set fails on a bad rule, so the previous rules stay", async () => {
    const dir = await tempProject({ "proj/.dovet/settings.local.json": '{ "permissions": { "deny": ["WebFetch"] } }' });
    open.push(dir);
    const input = {
      dirs: { config: join(dir.root, "cfg") },
      home: join(dir.root, "home"),
      projectRoot: join(dir.root, "proj"),
      env: {},
    };
    const prev = await snapshotSettings(input);
    const good = ruleSetFromSettings({ ...ctxFor(dir.root), loaded: prev.loaded });
    await writeFile(
      join(dir.root, "proj", ".dovet", "settings.local.json"),
      '{ "permissions": { "deny": ["Bash(ls) x"] } }',
    );
    const next = await pollSettings(prev, input);
    expect(next.loaded).toBe(prev.loaded);
    expect(next.warnings.length).toBeGreaterThan(0);
    expect(good.rules.list.map((r) => r.raw)).toContain("WebFetch");
  });
});
