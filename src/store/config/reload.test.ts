import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TempProject, tempProject } from "../../../test/helpers/index.ts";
import { pollSettings, snapshotSettings } from "./reload.ts";
import { UNTRUSTED } from "./trust.ts";

const projects: TempProject[] = [];
afterEach(async () => {
  await Promise.all(projects.splice(0).map((p) => p.dispose()));
});
async function setup(files: Record<string, string> = {}) {
  const dir = await tempProject(files);
  projects.push(dir);
  const input = {
    dirs: { config: join(dir.root, "cfg") },
    home: join(dir.root, "home"),
    projectRoot: join(dir.root, "proj"),
    trust: { project: true, local: true },
  };
  return { dir, input };
}

describe("live settings reload", () => {
  // spec: AC-PERM-19
  test("adding a deny rule to settings.local.json applies from the next poll with no stale rules", async () => {
    const { dir, input } = await setup({
      "proj/.dovet/settings.local.json": '{ "permissions": { "deny": ["Read(.env)"] } }',
    });
    const prev = await snapshotSettings({ ...input, env: {} });
    expect(prev.loaded.settings.permissions?.deny).toEqual(["Read(.env)"]);
    await mkdir(join(dir.root, "proj", ".dovet"), { recursive: true });
    await writeFile(
      join(dir.root, "proj", ".dovet", "settings.local.json"),
      '{ "permissions": { "deny": ["Read(.env)", "Bash(rm *)"] } }',
    );
    const next = await pollSettings(prev, { ...input, env: {} });
    expect(next.changed).toBe(true);
    expect(next.loaded.settings.permissions?.deny).toEqual(["Read(.env)", "Bash(rm *)"]);
    expect(next.notices.length).toBeGreaterThan(0);
    expect(next.events.some((e) => e.source === "file")).toBe(true);
    await writeFile(join(dir.root, "proj", ".dovet", "settings.local.json"), '{ "permissions": { "deny": [] } }');
    const third = await pollSettings(next.snapshot, { ...input, env: {} });
    expect(third.changed).toBe(true);
    expect(third.loaded.settings.permissions?.deny).toEqual([]);
  });

  // spec: AC-PERM-19
  test("creating .dovet/settings.json after startup is picked up in a trusted folder", async () => {
    const { dir, input } = await setup({});
    const prev = await snapshotSettings({ ...input, env: {} });
    expect(prev.loaded.settings.permissions?.deny ?? []).toEqual([]);
    await mkdir(join(dir.root, "proj", ".dovet"), { recursive: true });
    await writeFile(join(dir.root, "proj", ".dovet", "settings.json"), '{ "permissions": { "deny": ["Bash(rm *)"] } }');
    const next = await pollSettings(prev, { ...input, env: {} });
    expect(next.changed).toBe(true);
    expect(next.loaded.settings.permissions?.deny).toEqual(["Bash(rm *)"]);
  });

  // spec: AC-PERM-19
  test("an invalid edit keeps the previous settings with a warning naming file, line and key", async () => {
    const { dir, input } = await setup({
      "proj/.dovet/settings.local.json": '{ "permissions": { "deny": ["Read(.env)"] } }',
    });
    const prev = await snapshotSettings({ ...input, env: {} });
    await writeFile(
      join(dir.root, "proj", ".dovet", "settings.local.json"),
      '{\n  "permissions": {\n    "deny": [\n      "Read(.env)",\n      "Bash(ls) x"\n    ]\n  }\n}',
    );
    const next = await pollSettings(prev, { ...input, env: {} });
    expect(next.changed).toBe(false);
    // One warning per edit (Q45): the invalid file surfaces only through warnings.
    expect(next.notices).toEqual([]);
    expect(next.loaded.settings.permissions?.deny).toEqual(["Read(.env)"]);
    expect(next.warnings.length).toBeGreaterThan(0);
    const w = next.warnings[0];
    expect(w?.file).toContain("settings.local.json");
    expect(w?.line).toBeDefined();
    expect(w?.key).toContain("permissions.deny");
  });

  // spec: AC-PERM-19
  test.each(["model", "provider", "effort"] as const)(
    "a %s change in the file is announced, not applied",
    async (key) => {
      const { dir, input } = await setup({
        "proj/.dovet/settings.local.json": '{ "model": "m1", "provider": "p1", "effort": "low" }',
      });
      const prev = await snapshotSettings({ ...input, env: {} });
      // Different lengths so the rewrite is visible to stat polling even within one mtime tick.
      await writeFile(
        join(dir.root, "proj", ".dovet", "settings.local.json"),
        '{ "model": "model-two", "provider": "provider-two", "effort": "high" }',
      );
      const next = await pollSettings(prev, { ...input, env: {} });
      expect(next.changed).toBe(true);
      expect(next.loaded.settings[key]).toBe({ model: "m1", provider: "p1", effort: "low" }[key]);
      expect(next.announced).toContain(key);
      expect(
        next.notices.some(
          (n) =>
            n.includes({ model: "model-two", provider: "provider-two", effort: "high" }[key]) &&
            n.includes({ model: "m1", provider: "p1", effort: "low" }[key]),
        ),
      ).toBe(true);
    },
  );

  // spec: AC-PERM-19
  test("in-place edits to the user config file and .claude files are picked up by a poll", async () => {
    const { dir, input } = await setup({
      "cfg/settings.json": '{ "permissions": { "deny": [] } }',
      "home/.claude/settings.json": '{ "permissions": { "deny": [] } }',
      "proj/.claude/settings.json": '{ "permissions": { "deny": [] } }',
      "proj/.claude/settings.local.json": '{ "permissions": { "deny": [] } }',
      "proj/.dovet/settings.json": '{ "permissions": { "deny": [] } }',
    });
    // One file edited per poll: a dropped watch entry then goes undetected (in-place
    // writes don't move directory signatures) and fails. Sizes differ across edits.
    const targets: Array<{ path: string; deny: string }> = [
      { path: join(dir.root, "cfg", "settings.json"), deny: "WebFetch" },
      { path: join(dir.root, "home", ".claude", "settings.json"), deny: "Read(/a)" },
      { path: join(dir.root, "proj", ".claude", "settings.json"), deny: "Read(/b)" },
      { path: join(dir.root, "proj", ".claude", "settings.local.json"), deny: "Read(/c)" },
      { path: join(dir.root, "proj", ".dovet", "settings.json"), deny: "Read(/d)" },
    ];
    let snap = await snapshotSettings({ ...input, env: {} });
    expect(snap.loaded.settings.permissions?.deny ?? []).toEqual([]);
    for (const t of targets) {
      await writeFile(t.path, JSON.stringify({ permissions: { deny: [t.deny] } }));
      const next = await pollSettings(snap, { ...input, env: {} });
      expect(next.changed).toBe(true);
      expect(next.notices.some((n) => n.includes(t.path))).toBe(true);
      expect(next.loaded.settings.permissions?.deny).toContain(t.deny);
      snap = next.snapshot;
    }
  });

  // spec: AC-PERM-19
  test("flags survive a file removal and untrusted project edits can only restrict", async () => {
    const { dir, input } = await setup({
      "proj/.dovet/settings.json": '{ "permissions": { "additionalDirectories": ["/a"] } }',
    });
    const flags = { permissions: { additionalDirectories: ["/b"] } };
    const prev = await snapshotSettings({ ...input, env: {}, flags });
    await writeFile(join(dir.root, "proj", ".dovet", "settings.json"), '{ "permissions": {} }');
    const next = await pollSettings(prev, { ...input, env: {}, flags });
    expect(next.loaded.settings.permissions?.additionalDirectories).toEqual(["/b"]);

    const untrustedPrev = await snapshotSettings({ ...input, env: {}, trust: UNTRUSTED });
    await writeFile(
      join(dir.root, "proj", ".dovet", "settings.json"),
      '{ "permissions": { "allow": ["Bash(evil *)"], "deny": ["Bash(rm *)"] } }',
    );
    const untrustedNext = await pollSettings(untrustedPrev, { ...input, env: {}, trust: UNTRUSTED });
    expect(untrustedNext.loaded.rules.allow).toEqual([]);
    expect(untrustedNext.loaded.rules.deny.map((r) => r.rule)).toEqual(["Bash(rm *)"]);
  });

  // spec: AC-PERM-19
  test("no file change means no reload and no notices", async () => {
    const { input } = await setup({
      "proj/.dovet/settings.local.json": '{ "permissions": { "deny": ["Read(.env)"] } }',
    });
    const prev = await snapshotSettings({ ...input, env: {} });
    const next = await pollSettings(prev, { ...input, env: {} });
    expect(next.changed).toBe(false);
    expect(next.notices).toEqual([]);
    expect(next.events).toEqual([]);
    expect(next.loaded).toBe(prev.loaded);
  });

  // spec: AC-PERM-19
  test.skipIf(process.platform === "win32")("a symlinked settings file is checked at its target", async () => {
    const { dir, input } = await setup({ "dotfiles/local.json": '{ "permissions": { "deny": [] } }' });
    await mkdir(join(dir.root, "proj", ".dovet"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(join(dir.root, "dotfiles", "local.json"), join(dir.root, "proj", ".dovet", "settings.local.json"));
    const prev = await snapshotSettings({ ...input, env: {} });
    expect(prev.loaded.settings.permissions?.deny ?? []).toEqual([]);
    await writeFile(join(dir.root, "dotfiles", "local.json"), '{ "permissions": { "deny": ["WebFetch"] } }');
    const next = await pollSettings(prev, { ...input, env: {} });
    expect(next.changed).toBe(true);
    expect(next.loaded.settings.permissions?.deny).toEqual(["WebFetch"]);
  });
});
