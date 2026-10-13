import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TempProject, tempProject } from "../../../test/helpers/index.ts";
import { loadSettings, SettingsError } from "./index.ts";

const open: TempProject[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.dispose()));
});

async function setup(files: Record<string, string>) {
  const dir = await tempProject(files);
  open.push(dir);
  const input = {
    dirs: { config: join(dir.root, "cfg") },
    home: join(dir.root, "home"),
    projectRoot: join(dir.root, "proj"),
  };
  return { dir, input };
}

async function failure(promise: Promise<unknown>): Promise<SettingsError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SettingsError) return err;
    throw err;
  }
  throw new Error("expected loadSettings to reject");
}

describe("precedence", () => {
  // spec: AC-CLI-01
  test("each level beats every level below it", async () => {
    const { dir, input } = await setup({});
    const files: Record<string, string> = {
      "cfg/settings.json": '{ "effort": "low" }',
      "proj/.dovet/settings.json": '{ "effort": "medium" }',
      "proj/.dovet/settings.local.json": '{ "effort": "high" }',
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir.root, name, ".."), { recursive: true });
      await writeFile(join(dir.root, name), text);
    }
    const env = { DOVET_EFFORT: "xhigh" };
    const flags = { effort: "max" as const };
    expect((await loadSettings({ ...input, env: {} })).settings.effort).toBe("high");
    expect((await loadSettings({ ...input, env })).settings.effort).toBe("xhigh");
    expect((await loadSettings({ ...input, env, flags })).settings.effort).toBe("max");

    await rm(join(dir.root, "proj/.dovet/settings.local.json"));
    expect((await loadSettings({ ...input, env: {} })).settings.effort).toBe("medium");
    await rm(join(dir.root, "proj/.dovet/settings.json"));
    expect((await loadSettings({ ...input, env: {} })).settings.effort).toBe("low");
    await rm(join(dir.root, "cfg/settings.json"));
    expect((await loadSettings({ ...input, env: {} })).settings.effort).toBeUndefined();
  });

  // spec: AC-CLI-01
  test("built-in defaults are the lowest level", async () => {
    const { input } = await setup({ "cfg/settings.json": '{ "ui": { "theme": "dark" } }' });
    expect((await loadSettings({ ...input, env: {} })).settings.ui?.theme).toBe("dark");
    const empty = await setup({});
    const loaded = await loadSettings({ ...empty.input, env: {} });
    expect(loaded.settings.ui?.theme).toBe("auto");
    expect(loaded.settings.retention?.days).toBe(30);
  });

  test("objects merge deeply; null from a higher level clears a limit; plain arrays are replaced", async () => {
    const { input } = await setup({
      "cfg/settings.json": '{ "budget": { "session": 5, "daily": 20 }, "shell": { "passEnv": ["A"] } }',
      "proj/.dovet/settings.json": '{ "budget": { "session": null }, "shell": { "passEnv": ["B"] } }',
    });
    const { settings } = await loadSettings({ ...input, env: {} });
    expect(settings.budget).toMatchObject({ session: null, daily: 20 });
    expect(settings.shell?.passEnv).toEqual(["B"]);
  });

  test("permission rules concatenate across sources and keep their source", async () => {
    const { input } = await setup({
      "cfg/settings.json": '{ "permissions": { "deny": ["Read(.env)"] } }',
      "proj/.dovet/settings.json": '{ "permissions": { "deny": ["Bash(rm *)", "Read(.env)"] } }',
    });
    const loaded = await loadSettings({ ...input, env: {} });
    expect(loaded.settings.permissions?.deny).toEqual(["Read(.env)", "Bash(rm *)"]);
    expect(loaded.rules.deny.map((r) => [r.rule, r.source])).toEqual([
      ["Read(.env)", "user"],
      ["Bash(rm *)", "project"],
      ["Read(.env)", "project"],
    ]);
  });

  test("a key named __proto__ is reported, not applied", async () => {
    const { input } = await setup({ "cfg/settings.json": '{ "env": { "__proto__": "x" }, "__proto__": {} }' });
    const loaded = await loadSettings({ ...input, env: {} });
    expect(Object.getPrototypeOf(loaded.settings.env)).toBe(Object.prototype);
    expect(loaded.warnings.some((w) => w.key === "__proto__")).toBe(true);
  });
});

describe("invalid settings", () => {
  // spec: AC-CLI-03
  test("a plain-text API key stops startup and the error never repeats it", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnop";
    const { input } = await setup({
      "cfg/settings.json": `{\n  "providers": {\n    "anthropic": { "apiKey": "${secret}" }\n  }\n}`,
    });
    const err = await failure(loadSettings({ ...input, env: {} }));
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toMatchObject({ key: "providers.anthropic.apiKey", line: 3 });
    expect(err.problems[0]?.file).toBe(join(input.dirs.config, "settings.json"));
    expect(err.message).toContain("dovet auth login");
    expect(err.message).not.toContain(secret);
  });

  // spec: AC-CLI-03
  test("key references and none are accepted", async () => {
    const { input } = await setup({
      "cfg/settings.json": JSON.stringify({
        providers: {
          a: { apiKey: "env:MY_KEY" },
          b: { apiKey: "keychain:work" },
          c: { apiKey: "cmd:pass show k" },
          d: { apiKey: "none" },
        },
      }),
    });
    const loaded = await loadSettings({ ...input, env: {} });
    expect(Object.keys(loaded.settings.providers ?? {})).toEqual(["a", "b", "c", "d"]);
  });

  // spec: AC-CLI-11
  test("an invalid ui.theme is ignored with a warning while the file's deny rules apply", async () => {
    const { input } = await setup({
      "cfg/settings.json":
        '{\n  "ui": { "theme": "neon", "renderer": "plain" },\n  "permissions": { "deny": ["Read(.env)"] }\n}',
    });
    const loaded = await loadSettings({ ...input, env: {} });
    expect(loaded.settings.ui?.theme).toBe("auto");
    expect(loaded.settings.ui?.renderer).toBe("plain");
    expect(loaded.settings.permissions?.deny).toEqual(["Read(.env)"]);
    expect(loaded.warnings).toContainEqual(expect.objectContaining({ key: "ui.theme", line: 2 }));
  });

  // spec: AC-CLI-11
  test("an invalid permissions.deny entry stops startup with file, line and key", async () => {
    const { input } = await setup({
      "proj/.dovet/settings.json":
        '{\n  "permissions": {\n    "deny": [\n      "Read(.env)",\n      "Bash(ls) x"\n    ]\n  }\n}',
    });
    const err = await failure(loadSettings({ ...input, env: {} }));
    expect(err.problems[0]).toMatchObject({
      file: join(input.projectRoot, ".dovet", "settings.json"),
      line: 5,
      key: "permissions.deny[1]",
    });
    expect(err.message).toContain("settings.json:5");
    expect(err.message).toContain("permissions.deny[1]");
  });

  // spec: AC-CLI-11
  test("a policy key with the wrong type stops startup; a syntax error stops startup", async () => {
    const budget = await setup({ "cfg/settings.json": '{ "budget": { "session": "five" } }' });
    expect((await failure(loadSettings({ ...budget.input, env: {} }))).problems[0]?.key).toBe("budget.session");
    const broken = await setup({ "cfg/settings.json": '{ "ui": { "theme": "dark" ' });
    expect((await failure(loadSettings({ ...broken.input, env: {} }))).problems[0]?.message).toMatch(/CloseBrace/);
  });

  test("comments, trailing commas and an empty file are fine", async () => {
    const { input } = await setup({
      "cfg/settings.json": '// mine\n{ "effort": "low", /* why */ "model": "m", }\n',
      "proj/.dovet/settings.json": "",
    });
    expect((await loadSettings({ ...input, env: {} })).settings).toMatchObject({ effort: "low", model: "m" });
  });

  test("an unknown key is a warning with a suggestion", async () => {
    const { input } = await setup({ "cfg/settings.json": '{ "permisions": {}, "ui": { "thme": "dark" } }' });
    const loaded = await loadSettings({ ...input, env: {} });
    const messages = loaded.warnings.map((w) => `${w.key}: ${w.message}`);
    expect(messages.some((m) => m.startsWith("permisions") && m.includes('did you mean "permissions"'))).toBe(true);
    expect(messages.some((m) => m.startsWith("ui.thme") && m.includes('did you mean "theme"'))).toBe(true);
  });

  // spec: AC-CLI-11
  test("retention.days below 1 is rejected, not read as 'off'", async () => {
    const { input } = await setup({ "cfg/settings.json": '{ "retention": { "days": 0 } }' });
    const loaded = await loadSettings({ ...input, env: {} });
    expect(loaded.settings.retention?.days).toBe(30);
    expect(loaded.warnings.some((w) => w.key === "retention.days")).toBe(true);
  });

  test("numbers in env values become strings", async () => {
    const { input } = await setup({ "cfg/settings.json": '{ "env": { "PORT": 8080, "NAME": "x" } }' });
    expect((await loadSettings({ ...input, env: {} })).settings.env).toEqual({ PORT: "8080", NAME: "x" });
  });
});

describe("environment variables", () => {
  // spec: AC-CLI-11
  test("DOVET_BUDGET=1e2 means 100", async () => {
    const { input } = await setup({});
    const loaded = await loadSettings({
      ...input,
      env: { DOVET_BUDGET: "1e2", DOVET_MODEL: "m", DOVET_PROVIDER: "p" },
    });
    expect(loaded.settings.budget?.session).toBe(100);
    expect(loaded.settings).toMatchObject({ model: "m", provider: "p" });
  });

  // spec: AC-CLI-11
  test("a budget that isn't a plain number stops startup", async () => {
    const { input } = await setup({});
    for (const value of ["5abc", "0x10", "Infinity", "-3", "$5"]) {
      const err = await failure(loadSettings({ ...input, env: { DOVET_BUDGET: value } }));
      expect(err.problems[0]?.key).toBe("DOVET_BUDGET");
    }
  });

  test("a bad DOVET_EFFORT is ignored with a warning", async () => {
    const { input } = await setup({ "cfg/settings.json": '{ "effort": "low" }' });
    const loaded = await loadSettings({ ...input, env: { DOVET_EFFORT: "extreme" } });
    expect(loaded.settings.effort).toBe("low");
    expect(loaded.warnings.some((w) => w.key === "DOVET_EFFORT")).toBe(true);
  });
});

describe("reading files safely", () => {
  // spec: AC-CLI-11
  test("a 3 MB settings file is rejected clearly", async () => {
    const { input } = await setup({ "cfg/settings.json": `{ "model": "${"x".repeat(3 * 1024 * 1024)}" }` });
    const err = await failure(loadSettings({ ...input, env: {} }));
    expect(err.message).toMatch(/2 MiB/);
    expect(err.problems[0]?.file).toBe(join(input.dirs.config, "settings.json"));
  });

  // spec: AC-CLI-11
  test.skipIf(process.platform === "win32")(
    "a FIFO in place of a settings file is rejected without being opened",
    async () => {
      const { dir, input } = await setup({});
      await mkdir(join(dir.root, "cfg"), { recursive: true });
      expect(Bun.spawnSync(["mkfifo", join(dir.root, "cfg", "settings.json")]).exitCode).toBe(0);
      const err = await failure(loadSettings({ ...input, env: {} }));
      expect(err.message).toMatch(/not a regular file/);
    },
  );

  test("a directory in place of a settings file is rejected", async () => {
    const { dir, input } = await setup({});
    await mkdir(join(dir.root, "cfg", "settings.json"), { recursive: true });
    expect((await failure(loadSettings({ ...input, env: {} }))).message).toMatch(/not a regular file/);
  });
});

describe("Claude Code compatibility", () => {
  const claude = JSON.stringify({
    model: "claude-opus-4",
    hooks: { PreToolUse: [] },
    env: { FOO: "1" },
    apiKeyHelper: "x",
    permissions: { deny: ["Read(.env)"], allow: ["Bash(npm test)"], defaultMode: "acceptEdits" },
    sandbox: { enabled: true, somethingClaudeCodeOnly: 1 },
  });

  // spec: AC-CLI-18
  test("a project with only .claude/settings.json gets its portable subset, labeled, with a notice", async () => {
    const { input } = await setup({ "proj/.claude/settings.json": claude });
    const loaded = await loadSettings({ ...input, env: {} });
    expect(loaded.settings.permissions).toMatchObject({
      deny: ["Read(.env)"],
      allow: ["Bash(npm test)"],
      defaultMode: "acceptEdits",
    });
    expect(loaded.settings.sandbox?.enabled).toBe(true);
    expect(loaded.settings.model).toBeUndefined();
    expect(loaded.settings.env).toBeUndefined();
    expect(loaded.rules.deny).toEqual([
      { rule: "Read(.env)", source: "claude-project", file: join(input.projectRoot, ".claude", "settings.json") },
    ]);
    expect(loaded.notices).toEqual(["Using 2 permission rules from .claude/settings.json"]);
    expect(loaded.warnings).toEqual([]);
  });

  // spec: AC-CLI-18
  test("a Dovet file of the same scope wins over the Claude Code file", async () => {
    const { input } = await setup({
      "proj/.claude/settings.json": claude,
      "proj/.dovet/settings.json": '{ "permissions": { "defaultMode": "plan" } }',
    });
    const loaded = await loadSettings({ ...input, env: {} });
    expect(loaded.settings.permissions?.defaultMode).toBe("plan");
    expect(loaded.settings.permissions?.deny).toEqual(["Read(.env)"]);
  });

  // spec: AC-CLI-18
  test("the user-level Claude Code file is read too, and compat.claudeCodeSettings: false ignores all of them", async () => {
    const files = {
      "home/.claude/settings.json": '{ "permissions": { "deny": ["WebFetch"] } }',
      "proj/.claude/settings.json": claude,
      "proj/.claude/settings.local.json": '{ "permissions": { "allow": ["Bash(ls)"] } }',
    };
    const on = await setup(files);
    const loaded = await loadSettings({ ...on.input, env: {} });
    expect(loaded.settings.permissions?.deny).toEqual(["WebFetch", "Read(.env)"]);
    expect(loaded.settings.permissions?.allow).toEqual(["Bash(npm test)", "Bash(ls)"]);

    const off = await setup({ ...files, "cfg/settings.json": '{ "compat": { "claudeCodeSettings": false } }' });
    const ignored = await loadSettings({ ...off.input, env: {} });
    expect(ignored.settings.permissions?.deny).toEqual([]);
    expect(ignored.rules.deny).toEqual([]);
    expect(ignored.notices).toEqual([]);
  });

  test("a value Claude Code allows and Dovet doesn't is dropped with a warning, not a startup failure", async () => {
    const { input } = await setup({
      "proj/.claude/settings.json": '{ "permissions": { "defaultMode": "delegate", "deny": ["Read(.env)"] } }',
    });
    const loaded = await loadSettings({ ...input, env: {} });
    expect(loaded.settings.permissions?.deny).toEqual(["Read(.env)"]);
    expect(loaded.warnings.some((w) => w.key === "permissions.defaultMode")).toBe(true);
  });
});

describe("migration", () => {
  const migrations = [
    {
      to: 2,
      changes: [
        {
          kind: "rename" as const,
          from: "ui.fullscreen",
          to: "ui.renderer",
          value: (v: unknown) => (v === true ? "fullscreen" : "inline"),
        },
      ],
    },
  ];
  const before =
    '// my settings\n{\n  "$version": 1,\n  "ui": {\n    "fullscreen": true,\n    "theme": "dark" // keep this one\n  }\n}\n';

  // spec: AC-CLI-06
  test("confirming rewrites the file with comments kept", async () => {
    const { input } = await setup({ "cfg/settings.json": before });
    const asked: unknown[] = [];
    const loaded = await loadSettings({
      ...input,
      env: {},
      migrations,
      confirmMigration: (m) => {
        asked.push(m);
        return Promise.resolve(true);
      },
    });
    expect(asked).toEqual([
      { file: join(input.dirs.config, "settings.json"), changes: ['`ui.fullscreen` → `ui.renderer: "fullscreen"`'] },
    ]);
    const after = await readFile(join(input.dirs.config, "settings.json"), "utf8");
    expect(after).toContain("// my settings");
    expect(after).toContain("// keep this one");
    expect(after).toContain('"renderer": "fullscreen"');
    expect(after).not.toContain('fullscreen":');
    expect(after).toContain('"$version": 2');
    expect(loaded.settings.ui?.renderer).toBe("fullscreen");
    expect(loaded.warnings).toEqual([]);
  });

  // spec: AC-CLI-06
  test("declining leaves the file alone and applies the mapping in memory with a warning", async () => {
    const { input } = await setup({ "cfg/settings.json": before });
    const loaded = await loadSettings({
      ...input,
      env: {},
      migrations,
      confirmMigration: () => Promise.resolve(false),
    });
    expect(await readFile(join(input.dirs.config, "settings.json"), "utf8")).toBe(before);
    expect(loaded.settings.ui?.renderer).toBe("fullscreen");
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]?.message).toContain("ui.fullscreen");
  });

  // spec: AC-CLI-06
  test("with nobody to ask, the mapping applies in memory with a warning", async () => {
    const { input } = await setup({ "cfg/settings.json": before });
    const loaded = await loadSettings({ ...input, env: {}, migrations });
    expect(loaded.settings.ui?.renderer).toBe("fullscreen");
    expect(loaded.warnings).toHaveLength(1);
  });

  test("a file already at the current version is not touched or asked about", async () => {
    const text = '{ "$version": 2, "ui": { "renderer": "plain" } }';
    const { input } = await setup({ "cfg/settings.json": text });
    const loaded = await loadSettings({
      ...input,
      env: {},
      migrations,
      confirmMigration: () => {
        throw new Error("should not ask");
      },
    });
    expect(loaded.settings.ui?.renderer).toBe("plain");
    expect(await readFile(join(input.dirs.config, "settings.json"), "utf8")).toBe(text);
  });

  test("a removed key warns instead of being silently ignored", async () => {
    const { input } = await setup({ "cfg/settings.json": '{ "oldThing": 1 }' });
    const removal = [
      { to: 2, changes: [{ kind: "remove" as const, path: "oldThing", reason: "it no longer exists" }] },
    ];
    const loaded = await loadSettings({ ...input, env: {}, migrations: removal });
    expect(loaded.warnings.map((w) => w.message).join("\n")).toContain("oldThing");
    expect(loaded.warnings.map((w) => w.message).join("\n")).toContain("it no longer exists");
  });
});

describe("writing", () => {
  // spec: AC-CLI-18
  test("'don't ask again' writes to .dovet/settings.local.json, excludes it from git and leaves .claude/ alone", async () => {
    const claudeFile = '{ "permissions": { "deny": ["Read(.env)"] } }';
    const { dir, input } = await setup({ "proj/.claude/settings.json": claudeFile, "proj/.git/HEAD": "ref: x\n" });
    const { saveLocalRule } = await import("./index.ts");
    await saveLocalRule(input.projectRoot, "allow", "Bash(npm test)");
    await saveLocalRule(input.projectRoot, "allow", "Bash(ls)");
    await saveLocalRule(input.projectRoot, "allow", "Bash(npm test)");
    expect(await readFile(join(dir.root, "proj/.claude/settings.json"), "utf8")).toBe(claudeFile);
    const loaded = await loadSettings({ ...input, env: {} });
    expect(loaded.settings.permissions?.allow).toEqual(["Bash(npm test)", "Bash(ls)"]);
    expect(loaded.rules.allow.map((r) => r.source)).toEqual(["local", "local"]);
    const exclude = await readFile(join(dir.root, "proj/.git/info/exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/.dovet/settings.local.json")).toHaveLength(1);
  });

  test("existing comments and other keys survive a rule being added", async () => {
    const text = '// mine\n{\n  "model": "m", // keep\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n';
    const { dir, input } = await setup({ "proj/.dovet/settings.local.json": text });
    const { saveLocalRule } = await import("./index.ts");
    await saveLocalRule(input.projectRoot, "allow", "Bash(pwd)");
    const after = await readFile(join(dir.root, "proj/.dovet/settings.local.json"), "utf8");
    expect(after).toContain("// mine");
    expect(after).toContain("// keep");
    expect(after).toContain('"Bash(ls)"');
    expect(after).toContain('"Bash(pwd)"');
  });

  test.skipIf(process.platform === "win32")(
    "a symlinked settings file is written at its target and stays a link",
    async () => {
      const { dir, input } = await setup({ "dotfiles/local.json": '{ "model": "m" }' });
      await mkdir(join(dir.root, "proj/.dovet"), { recursive: true });
      const { symlink, lstat } = await import("node:fs/promises");
      await symlink(join(dir.root, "dotfiles/local.json"), join(dir.root, "proj/.dovet/settings.local.json"));
      const { saveLocalRule } = await import("./index.ts");
      await saveLocalRule(input.projectRoot, "deny", "WebFetch");
      expect((await lstat(join(dir.root, "proj/.dovet/settings.local.json"))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(dir.root, "dotfiles/local.json"), "utf8")).toContain("WebFetch");
      expect((await stat(join(dir.root, "dotfiles/local.json"))).isFile()).toBe(true);
    },
  );
});
