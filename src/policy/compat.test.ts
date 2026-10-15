// Compatibility corpus runner (AC-PERM-14): a real Claude Code settings.json imported through
// the settings loader produces the documented decisions, except where §0b differs (listed per case).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempProject } from "../../test/helpers/index.ts";
import type { Os } from "../platform/index.ts";
import { canonicalizePath } from "../platform/index.ts";
import type { PermissionMode } from "../schema/index.ts";
import { loadSettings } from "../store/index.ts";
import { decide, type Env, exampleDecider, type State } from "./decide/index.ts";
import { ruleSetFromSettings } from "./grants/index.ts";
import { loadRules, type RuleSet } from "./rules/index.ts";
import { analyzeShell } from "./shell-parse/analyze.ts";
import { expandGlob, isDirectory } from "./shell-parse/glob.ts";
import { loadShellParsers, type ShellLanguage, type ShellParsers } from "./shell-parse/load.ts";

type CorpusEntry = {
  id: string;
  source: string;
  settings?: { allow?: string[]; ask?: string[]; deny?: string[] };
  mode?: PermissionMode;
  tool: string;
  command?: string;
  path?: string;
  url?: string;
  sandboxed?: boolean;
  tainted?: boolean;
  expect: "allow" | "ask" | "deny";
  claude?: "allow" | "ask" | "deny";
  differing?: string;
};

let parsers: ShellParsers;
let root = "";
let dispose: () => Promise<void>;
beforeAll(async () => {
  parsers = await loadShellParsers();
  const project = await tempProject({
    "a.ts": "a",
    ".env": "K=1",
    "src/x.ts": "x",
    "secrets.yml": "s",
    ".git/HEAD": "x\n",
  });
  root = project.root;
  dispose = project.dispose;
});
afterAll(() => dispose());

const os = process.platform as Os;
const envFor = (): Env => ({
  os,
  home: join(root, "..", "home"),
  cwd: root,
  workingDirs: [root],
  canonicalize: (p) => canonicalizePath(p, root, os),
  pid: 4242,
  ppid: 4241,
  selfNames: ["dovet", "bun"],
});
const rulesFor = (s: NonNullable<CorpusEntry["settings"]>): RuleSet =>
  loadRules(
    [
      {
        file: "/compat/settings.json",
        baseDir: root,
        allow: (s.allow ?? []).map((text) => ({ text })),
        ask: (s.ask ?? []).map((text) => ({ text })),
        deny: (s.deny ?? []).map((text) => ({ text })),
      },
    ],
    { os, home: join(root, "..", "home"), canonicalize: (p) => p },
  ).rules;

function behaviorOf(e: CorpusEntry): "allow" | "ask" | "deny" {
  const st: State = {
    mode: e.mode ?? "default",
    rules: rulesFor(e.settings ?? {}),
    env: envFor(),
    sandboxAutoAllow: true,
    ...(e.tainted === true ? { tainted: true as const } : {}),
  };
  if (e.tool === "Bash" || e.tool === "PowerShell") {
    const language = (e.tool === "Bash" ? "bash" : "powershell") as ShellLanguage;
    const analysis = analyzeShell(parsers, language, e.command ?? "", {
      cwd: st.env.cwd,
      workingDirs: st.env.workingDirs,
      home: st.env.home,
      glob: expandGlob,
      isDirectory,
    });
    return decide({ tool: e.tool, action: { kind: "shell", analysis, sandboxed: e.sandboxed ?? true } }, st).behavior;
  }
  if (e.tool === "Read" || e.tool === "Edit") {
    const p = e.path ?? "";
    const abs = p.startsWith("../") || p.startsWith("./") || !p.startsWith("/") ? join(root, p) : p;
    return decide({ tool: e.tool, action: { kind: e.tool === "Read" ? "read" : "edit", paths: [abs] } }, st).behavior;
  }
  if (e.tool === "WebFetch") {
    const host = URL.canParse(e.url ?? "") ? new URL(e.url ?? "").hostname : (e.url ?? "");
    return decide({ tool: "WebFetch", action: { kind: "network", host } }, st).behavior;
  }
  throw new Error(`unknown tool ${e.tool}`);
}

describe("Claude Code compatibility corpus", () => {
  // spec: AC-PERM-14
  test("every corpus case decides as documented, with §0b differences listed", async () => {
    const text = await Bun.file(join(import.meta.dir, "testdata", "compat-corpus.jsonl")).text();
    const entries = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as CorpusEntry);
    expect(entries.length).toBe(200);
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(200);
    const failures: string[] = [];
    for (const e of entries) {
      const got = behaviorOf(e);
      if (got !== e.expect)
        failures.push(`${e.id}: ${e.tool} ${e.command ?? e.path ?? e.url} → ${got}, expected ${e.expect}`);
      if (e.differing !== undefined && e.claude === e.expect)
        failures.push(`${e.id}: differing listed but claude equals expect`);
      if (e.differing === undefined && e.claude !== undefined && e.claude !== e.expect)
        failures.push(`${e.id}: claude differs but no differing reason`);
    }
    expect(failures).toEqual([]);
  });

  // spec: AC-PERM-14
  test("a real .claude/settings.json imported through the loader decides the same way", async () => {
    const repo = await tempProject({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(npm run *)", "Bash(git commit *)"], deny: ["Bash(git push *)", "Read(.env)"] },
      }),
      ".git/HEAD": "x\n",
      "a.ts": "a",
      ".env": "K=1",
    });
    try {
      const loaded = await loadSettings({
        dirs: { config: join(repo.root, "cfg") },
        home: repo.root,
        projectRoot: repo.root,
        env: {},
      });
      const env = envFor();
      const { rules } = ruleSetFromSettings({
        loaded,
        env: {
          ...env,
          cwd: repo.root,
          workingDirs: [repo.root],
          canonicalize: (p) => canonicalizePath(p, repo.root, os),
        },
        parsers,
        ruleContext: { os, home: env.home, canonicalize: (p) => p },
        configDir: join(repo.root, "cfg"),
      });
      const decider = exampleDecider(
        {
          mode: "default",
          rules,
          env: {
            ...env,
            cwd: repo.root,
            workingDirs: [repo.root],
            canonicalize: (p) => canonicalizePath(p, repo.root, os),
          },
          sandboxAutoAllow: true,
        },
        parsers,
      );
      const at = (tool: string, value: string) => decider(tool, value, repo.root)?.behavior;
      expect(at("Bash", "npm run test")).toBe("allow");
      expect(at("Bash", "git push origin main")).toBe("deny");
      expect(at("Read", join(repo.root, ".env"))).toBe("deny");
      expect(at("Read", join(repo.root, "a.ts"))).toBe("allow");
    } finally {
      await repo.dispose();
    }
  });

  // spec: AC-PERM-14
  test("representative rule shapes survive the real .claude loader", async () => {
    const text = await Bun.file(join(import.meta.dir, "testdata", "compat-corpus.jsonl")).text();
    const entries = new Map(
      text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as CorpusEntry)
        .map((e) => [e.id, e]),
    );
    const ids = [
      "c001",
      "c005",
      "c018",
      "c023",
      "c030",
      "c036",
      "c056",
      "c064",
      "c076",
      "c086",
      "c092",
      "c093",
      "c111",
      "c113",
      "c126",
      "c151",
      "c166",
      "c178",
      "c186",
      "c191",
    ];
    for (const id of ids) {
      const e = entries.get(id);
      if (e === undefined) throw new Error(`missing corpus entry ${id}`);
      const repo = await tempProject({
        ".claude/settings.json": JSON.stringify({ permissions: e.settings ?? {} }),
        ".git/HEAD": "x\n",
        "a.ts": "a",
        ".env": "K=1",
        "src/x.ts": "x",
      });
      try {
        const loaded = await loadSettings({
          dirs: { config: join(repo.root, "cfg") },
          home: repo.root,
          projectRoot: repo.root,
          env: {},
        });
        const base = envFor();
        const env = {
          ...base,
          cwd: repo.root,
          workingDirs: [repo.root],
          canonicalize: (p: string) => canonicalizePath(p, repo.root, os),
        };
        const { rules } = ruleSetFromSettings({
          loaded,
          env,
          parsers,
          ruleContext: { os, home: base.home, canonicalize: (p: string) => p },
          configDir: join(repo.root, "cfg"),
        });
        const st: State = {
          mode: e.mode ?? "default",
          rules,
          env,
          sandboxAutoAllow: true,
          ...(e.tainted === true ? { tainted: true as const } : {}),
        };
        let got: string;
        if (e.tool === "Bash" || e.tool === "PowerShell") {
          const language = (e.tool === "Bash" ? "bash" : "powershell") as ShellLanguage;
          const analysis = analyzeShell(parsers, language, e.command ?? "", {
            cwd: env.cwd,
            workingDirs: env.workingDirs,
            home: env.home,
            glob: expandGlob,
            isDirectory,
          });
          got = decide(
            { tool: e.tool, action: { kind: "shell", analysis, sandboxed: e.sandboxed ?? true } },
            st,
          ).behavior;
        } else if (e.tool === "Read" || e.tool === "Edit") {
          const p = e.path ?? "";
          const abs = p.startsWith("../") || p.startsWith("./") || !p.startsWith("/") ? join(repo.root, p) : p;
          got = decide(
            { tool: e.tool, action: { kind: e.tool === "Read" ? "read" : "edit", paths: [abs] } },
            st,
          ).behavior;
        } else {
          const host = URL.canParse(e.url ?? "") ? new URL(e.url ?? "").hostname : (e.url ?? "");
          got = decide({ tool: "WebFetch", action: { kind: "network", host } }, st).behavior;
        }
        expect(got, id).toBe(e.expect);
      } finally {
        await repo.dispose();
      }
    }
  });
});
