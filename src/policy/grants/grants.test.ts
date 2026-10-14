import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempProject } from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import { canonicalizePath } from "../../platform/index.ts";
import type { PermissionMode } from "../../schema/index.ts";
import {
  findProjectRoot,
  type LoadedSettings,
  loadSettings,
  projectId,
  SettingsError,
  sessionPaths,
} from "../../store/index.ts";
import { decide, type Env, type Request, type State } from "../decide/index.ts";
import { evaluateRules, loadRules, type RuleSet } from "../rules/index.ts";
import { analyzeShell } from "../shell-parse/analyze.ts";
import { expandGlob, isDirectory } from "../shell-parse/glob.ts";
import { loadShellParsers, type ShellParsers } from "../shell-parse/load.ts";
import { effectsOf, ruleSetFromSettings, saveGrant, suggestGrant } from "./index.ts";

let parsers: ShellParsers;
let root = "";
let dispose: () => Promise<void>;
beforeAll(async () => {
  parsers = await loadShellParsers();
  const project = await tempProject({ "a.ts": "a", ".env": "K=1", "src/x.ts": "x", ".git/HEAD": "x\n" });
  root = project.root;
  dispose = project.dispose;
});
afterAll(() => dispose());

const os = process.platform as Os;
const env = (): Env => ({
  os,
  home: join(root, "..", "home"),
  cwd: root,
  workingDirs: [root],
  canonicalize: (p) => canonicalizePath(p, root, os),
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
    {
      os,
      home: "/home/u",
      canonicalize: (p) => p,
    },
  ).rules;
const state = (over: Partial<State> = {}, mode: PermissionMode = "default", allow: string[] = []): State => ({
  mode,
  rules: rulesFor(allow),
  env: env(),
  ...over,
});
const shell = (command: string, st: State, sandboxed = false): Request => ({
  tool: "Bash",
  action: {
    kind: "shell",
    sandboxed,
    analysis: analyzeShell(parsers, "bash", command, {
      cwd: st.env.cwd,
      workingDirs: st.env.workingDirs,
      home: st.env.home,
      glob: expandGlob,
      isDirectory,
    }),
  },
});
const fileReq = (kind: "read" | "edit", path: string, tool = kind === "read" ? "Read" : "Edit"): Request => ({
  tool,
  action: { kind, paths: [path] },
});

describe("effectsOf", () => {
  test("an edit in the project writes to the workspace; outside it, outside; in .git, protected", () => {
    const st = state();
    for (const [path, writes] of [
      [join(root, "a.ts"), "workspace"],
      [join(root, "..", "elsewhere.txt"), "outside"],
      [join(root, ".git", "config"), "protected"],
    ] as const) {
      const req = fileReq("edit", path);
      expect(effectsOf(req, decide(req, st), false).writes).toBe(writes);
    }
  });

  test("a sensitive read lists the file; a push lists the remote kind", () => {
    const st = state();
    const sensitive = fileReq("read", join(root, ".env"));
    expect(effectsOf(sensitive, decide(sensitive, st), false).sensitiveReads).toEqual([join(root, ".env")]);
    const push = shell("git push origin feature", st);
    const e = effectsOf(push, decide(push, st), true);
    expect(e.remote).toEqual(["push"]);
    expect(e.sandboxed).toBe(true);
  });

  test("a read-only command has no effects; a new host is listed", () => {
    const st = state();
    const ls = shell("ls", st);
    expect(effectsOf(ls, decide(ls, st), true)).toMatchObject({ writes: "none", network: "none" });
    const fetch: Request = { tool: "WebFetch", action: { kind: "network", host: "api.example.com" } };
    expect(effectsOf(fetch, decide(fetch, st), false).network).toEqual({ newHosts: ["api.example.com"] });
  });
});

describe("suggestGrant", () => {
  // spec: AC-PERM-18
  test("a shell prompt offers one permanent rule per subcommand that needed approval", () => {
    const st = state();
    const req = shell("npm run build && ls && git commit -m msg", st);
    const g = suggestGrant(req, decide(req, st), st);
    expect(g).toEqual({ scope: "permanent", rules: ["Bash(npm run *)", "Bash(git commit *)"] });
  });

  // spec: AC-PERM-18
  test("every generated rule matches its own command again", () => {
    const st = state();
    for (const command of ["npm run build", "git commit -m 'a b'", "python x.py", "rm -rf build", "cargo test --all"]) {
      const req = shell(command, st);
      const g = suggestGrant(req, decide(req, st), st);
      expect(g).toBeDefined();
      const after = { ...st, rules: rulesFor(g?.rules) };
      expect(decide(req, after).behavior).toBe("allow");
    }
  });

  test("never Bash(*): a wildcard in an argument, a forced push, or an unparsed command withholds or narrows", () => {
    const st = state();
    const glob = shell("echo 'a*'", st);
    expect(suggestGrant(glob, decide(glob, st), st)?.rules ?? []).not.toContain("Bash(*)");
    const force = shell("git push --force origin feature", st);
    expect(suggestGrant(force, decide(force, st), st)?.rules).toEqual(["Bash(git push --force origin feature)"]);
    const odd = shell("echo $(", st);
    expect(suggestGrant(odd, decide(odd, st), st)).toBeUndefined();
  });

  test("more than five subcommands, bidirectional text and safety prompts offer nothing", () => {
    const st = state();
    const six = shell("a1 && a2 && a3 && a4 && a5 && a6", st);
    expect(suggestGrant(six, decide(six, st), st)).toBeUndefined();
    const bidi = shell("echo ‮evil", st);
    expect(suggestGrant(bidi, decide(bidi, st), st)).toBeUndefined();
    const git = fileReq("edit", join(root, ".git", "config"));
    expect(suggestGrant(git, decide(git, st), st)).toBeUndefined();
  });

  test("file edits are for the session; WebFetch saves a domain rule; a tainted session offers no host rule", () => {
    const st = state();
    const edit = fileReq("edit", join(root, "src", "x.ts"));
    const g = suggestGrant(edit, decide(edit, st), st);
    expect(g?.scope).toBe("session");
    expect(g?.rules).toHaveLength(1);
    const after = { ...st, rules: rulesFor(g?.rules) };
    expect(decide(edit, after).behavior).toBe("allow");

    const fetch: Request = { tool: "WebFetch", action: { kind: "network", host: "api.example.com" } };
    expect(suggestGrant(fetch, decide(fetch, st), st)).toEqual({
      scope: "permanent",
      rules: ["WebFetch(domain:api.example.com)"],
    });
    const tainted = { ...st, tainted: true };
    expect(suggestGrant(fetch, decide(fetch, tainted), tainted)).toBeUndefined();
  });

  test("a sensitive read saves an exact Read rule; an outside read saves a directory rule; metacharacters are escaped", () => {
    const st = state();
    const env0 = join(root, ".env");
    const sensitive = fileReq("read", env0);
    const g = suggestGrant(sensitive, decide(sensitive, st), st);
    expect(g?.scope).toBe("permanent");
    expect(decide(sensitive, { ...st, rules: rulesFor(g?.rules) }).behavior).toBe("allow");
    expect(decide(fileReq("read", join(root, "src", ".env")), { ...st, rules: rulesFor(g?.rules) }).behavior).toBe(
      "ask",
    );

    const outside = join(root, "..", "docs [v1]", "n.md");
    const req = fileReq("read", outside);
    const o = suggestGrant(req, decide(req, st), st);
    expect(o?.rules[0]).toMatch(/^Read\(.*\/\*\*\)$/);
    const after = { ...st, rules: rulesFor(o?.rules) };
    expect(decide(req, after).behavior).toBe("allow");
    expect(decide(fileReq("read", join(root, "..", "docs v", "n.md")), after).behavior).toBe("ask");
    expect(
      evaluateRules(after.rules, { tool: "Read", cwd: root, paths: [{ access: "read", path: outside }] })?.behavior,
    ).toBe("allow");
  });
});

describe("saveGrant", () => {
  // spec: AC-CLI-10
  test("a permanent grant lands in settings.local.json at the project root and is excluded from git", async () => {
    await saveGrant({ scope: "permanent", rules: ["Bash(npm run *)", "Bash(git commit *)"] }, root);
    const saved = JSON.parse(readFileSync(join(root, ".dovet", "settings.local.json"), "utf8"));
    expect(saved.permissions.allow).toEqual(["Bash(npm run *)", "Bash(git commit *)"]);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain("/.dovet/settings.local.json");
  });

  test("a session grant is returned for the agent to hold and is never written", async () => {
    const before = readFileSync(join(root, ".dovet", "settings.local.json"), "utf8");
    expect(await saveGrant({ scope: "session", rules: ["Edit(//x)"] }, root)).toEqual(["Edit(//x)"]);
    expect(readFileSync(join(root, ".dovet", "settings.local.json"), "utf8")).toBe(before);
  });
});

describe("started in a subdirectory", () => {
  // spec: AC-CLI-10
  test("an edit outside the working directory prompts; the saved rule and the session belong to the repository root", async () => {
    const repo = await tempProject({ ".git/HEAD": "x\n", "pkg/a.ts": "", "other/b.ts": "" });
    try {
      const start = join(repo.root, "pkg");
      const projectRoot = await findProjectRoot(start);
      expect(projectRoot).toBe(repo.root);
      const st = state({ env: { ...env(), cwd: start, workingDirs: [start] } });
      const edit = fileReq("edit", join(repo.root, "other", "b.ts"));
      const d = decide(edit, st);
      expect(d.behavior).toBe("ask");
      expect(d.by).toContain("working-directory check");

      const build = shell("npm run build", st);
      const grant = suggestGrant(build, decide(build, st), st);
      expect(grant?.scope).toBe("permanent");
      if (grant !== undefined) await saveGrant(grant, projectRoot);
      const saved = JSON.parse(readFileSync(join(repo.root, ".dovet", "settings.local.json"), "utf8"));
      expect(saved.permissions.allow).toEqual(["Bash(npm run *)"]);

      const sessions = sessionPaths({ data: "/data", projectRoot, os, session: "s1" }).dir;
      expect(sessions).toContain(projectId(repo.root, os));
      expect(sessions).not.toContain(projectId(start, os));
    } finally {
      await repo.dispose();
    }
  });
});

describe("ruleSetFromSettings", () => {
  async function load(settings: Record<string, unknown>): Promise<LoadedSettings> {
    const dir = (await tempProject()).root;
    mkdirSync(join(dir, ".dovet"), { recursive: true });
    writeFileSync(join(dir, ".dovet", "settings.json"), JSON.stringify(settings));
    return loadSettings({ dirs: { config: join(dir, "cfg") }, home: dir, projectRoot: dir, env: {} });
  }
  const build = (loaded: LoadedSettings) =>
    ruleSetFromSettings({
      loaded,
      env: env(),
      parsers,
      ruleContext: { os, home: env().home, canonicalize: env().canonicalize },
      configDir: join(root, "cfg"),
    });

  // spec: AC-PERM-29
  test("a failing permissions.examples entry fails at load and names the deciding rule", async () => {
    const loaded = await load({
      permissions: { allow: ["Bash(git *)"], examples: [{ Bash: "git push --force origin main", expect: "ask" }] },
    });
    let error: unknown;
    try {
      build(loaded);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SettingsError);
    expect(String(error)).toContain("git push --force origin main");
    expect(String(error)).toContain("expected ask but is deny");
  });

  test("passing examples build a working rule set; a malformed rule fails naming the file", async () => {
    const ok = build(
      await load({
        permissions: { allow: ["Bash(npm run *)"], examples: [{ Bash: "npm run build", expect: "allow" }] },
      }),
    );
    expect(ok.rules.list.map((r) => r.raw)).toEqual(["Bash(npm run *)"]);
    expect(() => build(loadedWith(["Bash(ls) x"]))).toThrow("settings.json");
  });
});

function loadedWith(allow: string[]): LoadedSettings {
  return {
    settings: {},
    rules: {
      allow: allow.map((rule) => ({ rule, source: "project", file: "/p/.dovet/settings.json" })),
      ask: [],
      deny: [],
    },
    warnings: [],
    notices: [],
    files: [],
  };
}
