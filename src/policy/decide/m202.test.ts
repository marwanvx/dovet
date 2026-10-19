// M2-02 failing tests first (permissions §7.4, §10, §4.0): AC-PERM-11, 12, 23, 27.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempProject } from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import { canonicalizePath } from "../../platform/index.ts";
import type { PermissionMode } from "../../schema/index.ts";
import { suggestGrant } from "../grants/suggest.ts";
import { loadRules, type RuleSet } from "../rules/index.ts";
import { analyzeShell } from "../shell-parse/analyze.ts";
import { expandGlob, isDirectory } from "../shell-parse/glob.ts";
import { loadShellParsers, type ShellParsers } from "../shell-parse/load.ts";
import { decide, type Env, type State } from "./index.ts";

let parsers: ShellParsers;
let root = "";
let dispose: () => Promise<void>;
beforeAll(async () => {
  parsers = await loadShellParsers();
  const project = await tempProject({ "a.ts": "a", ".env": "K=1" });
  root = project.root;
  dispose = project.dispose;
});
afterAll(() => dispose());

const os = process.platform as Os;
const env = (over: Partial<Env> = {}): Env => ({
  os,
  home: join(root, "..", "home"),
  cwd: root,
  workingDirs: [root],
  canonicalize: (p) => canonicalizePath(p, root, os),
  pid: 4242,
  ppid: 4241,
  selfNames: ["dovet", "bun"],
  ...over,
});
const rulesFor = (lists: { allow?: string[]; ask?: string[]; deny?: string[] } = {}): RuleSet => {
  const texts = (xs: string[] = []) => xs.map((text) => ({ text }));
  return loadRules(
    [{ file: "/p/s.json", baseDir: root, allow: texts(lists.allow), ask: texts(lists.ask), deny: texts(lists.deny) }],
    { os, home: join(root, "..", "home"), canonicalize: (p) => canonicalizePath(p, root, os) },
  ).rules;
};
const state = (mode: PermissionMode, lists: Parameters<typeof rulesFor>[0] = {}, over: Partial<State> = {}): State => ({
  mode,
  rules: rulesFor(lists),
  env: env(),
  ...over,
});
const sh = (command: string, st: State, sandboxed = false) => {
  const analysis = analyzeShell(parsers, "bash", command, {
    cwd: st.env.cwd,
    workingDirs: st.env.workingDirs,
    home: st.env.home,
    glob: expandGlob,
    isDirectory,
  });
  return decide({ tool: "Bash", action: { kind: "shell", analysis, sandboxed } }, st);
};
const fetch = (host: string, st: State) => decide({ tool: "WebFetch", action: { kind: "network", host } }, st);

// spec: AC-PERM-11
describe("AC-PERM-11 network unknown and local refusal", () => {
  test("unknown domain prompts in Manual, refused in dontAsk, allowed in bypass", () => {
    expect(fetch("example.com", state("default")).behavior).toBe("ask");
    expect(fetch("example.com", state("dontAsk")).behavior).toBe("deny");
    expect(fetch("example.com", state("bypassPermissions")).behavior).toBe("allow");
  });
  test("169.254.169.254 is refused after resolution in every mode", () => {
    for (const mode of ["default", "dontAsk", "bypassPermissions"] as const) {
      expect(fetch("169.254.169.254", state(mode)).behavior, mode).toBe("deny");
    }
  });
});

// spec: AC-PERM-12
describe("AC-PERM-12 taint suspends auto-allow and denies push", () => {
  test("a previously auto-allowed sandboxed command prompts once tainted", () => {
    const clean = state("default", {}, { sandboxAutoAllow: true });
    expect(sh("npm test", clean, true).behavior).toBe("allow");
    const tainted = state("default", {}, { sandboxAutoAllow: true, tainted: true });
    expect(sh("npm test", tainted, true).behavior).toBe("ask");
    const allowed = state("default", { allow: ["Bash(npm test *)"] }, { sandboxAutoAllow: true, tainted: true });
    expect(sh("npm test", allowed, true).behavior).toBe("allow");
  });
  test("git push is denied while tainted even with an allow rule", () => {
    for (const mode of ["default", "bypassPermissions", "dontAsk"] as const) {
      const st = state(mode, { allow: ["Bash(git push)"] }, { sandboxAutoAllow: true, tainted: true });
      expect(sh("git push", st, true).behavior, mode).toBe("deny");
    }
  });
});

// spec: AC-PERM-23
describe("AC-PERM-23 lower analysis bar under sandbox auto-allow", () => {
  test("expansions, inline scripts and heredocs run unprompted when sandboxed", () => {
    const st = state("default", {}, { sandboxAutoAllow: true });
    for (const c of [
      'FOO=bar python3 -c "x=1"',
      "python3 <<EOF\nhello\nEOF",
      "cat <<EOF | node\nhello\nEOF",
      "echo $(date)",
    ])
      expect(sh(c, st, true).behavior, c).toBe("allow");
  });
  test("dynamic command names still ask; deny rules still catch", () => {
    const st = state("default", {}, { sandboxAutoAllow: true });
    expect(sh('eval "$x"', st, true).behavior).toBe("ask");
    expect(sh("$cmd args", st, true).behavior).toBe("ask");
    expect(sh('sh -c "$x"', st, true).behavior).toBe("ask");
    expect(sh('FOO=bar eval "$x"', st, true).behavior).toBe("ask");
    expect(sh("FOO=bar source ./setup.sh", st, true).behavior).toBe("ask");
    expect(sh("FOO=bar exec curl https://example.com", st, true).behavior).toBe("ask");
    expect(sh('env eval "$x"', st, true).behavior).toBe("ask");
    expect(sh("env $cmd args", st, true).behavior).toBe("ask");
    expect(sh('env sh -c "$script"', st, true).behavior).toBe("ask");
    expect(sh("cat list.txt | xargs", st, true).behavior).toBe("ask");
    expect(sh("xargs -0", st, true).behavior).toBe("ask");
    expect(sh("echo git push | xargs", st, true).behavior).toBe("ask");
    expect(sh("echo git push | xargs --max-args 1", st, true).behavior).toBe("ask");
    expect(sh("echo git push | xargs --max-args=1", st, true).behavior).toBe("ask");
    expect(sh("echo git push | env xargs", st, true).behavior).toBe("ask");
    expect(sh("echo hi | xargs $cmd", st, true).behavior).toBe("ask");
    expect(sh("echo hi | env xargs $cmd", st, true).behavior).toBe("ask");
    expect(sh("printf '%s\\n' a | xargs grep -l foo", st, true).behavior).toBe("allow");
    expect(sh("printf '%s\\n' a | env xargs --max-args 1 grep -l foo", st, true).behavior).toBe("allow");
    const denied = state("default", { deny: ["Bash(rm *)"] }, { sandboxAutoAllow: true });
    expect(sh('TZ="$HOME" rm -rf build', denied, true).behavior).toBe("deny");
  });
});

// spec: AC-PERM-27
describe("AC-PERM-27 taint triggers and effects", () => {
  test("while tainted, publish and push are denied", () => {
    const st = state("default", {}, { sandboxAutoAllow: true, tainted: true });
    expect(sh("npm publish", st, true).behavior).toBe("deny");
    expect(sh("git push", st, true).behavior).toBe("deny");
  });
  test("sensitive-file read prompts with the tainted banner", () => {
    const tainted = state("default", {}, { tainted: true, taintSource: "WebFetch: example.com" });
    const d = decide({ tool: "Read", action: { kind: "read", paths: [join(root, ".env")] } }, tainted);
    expect(d.behavior).toBe("ask");
    expect(d.reason).toContain("tainted");
  });
  test("taint re-prompts a sensitive path that already has a pre-taint grant", () => {
    const envPath = join(root, ".env");
    const st0 = state("default");
    const req = { tool: "Read", action: { kind: "read" as const, paths: [envPath] } };
    const g = suggestGrant(req, decide(req, st0), st0);
    expect(g).toBeDefined();
    const allow = g?.rules ?? [];
    const untainted = state("default", { allow });
    expect(decide(req, untainted).behavior).toBe("allow");
    const tainted = state("default", { allow }, { tainted: true, taintSource: "WebFetch: example.com" });
    const d = decide(req, tainted);
    expect(d.behavior).toBe("ask");
    expect(d.reason).toContain("tainted");
  });
  test("while tainted there is no don't-ask-again for sensitive reads or new hosts", () => {
    const tainted = state("default", {}, { tainted: true, taintSource: "WebFetch: example.com" });
    const sensitiveReq = { tool: "Read", action: { kind: "read" as const, paths: [join(root, ".env")] } };
    expect(suggestGrant(sensitiveReq, decide(sensitiveReq, tainted), tainted)).toBeUndefined();
    const netReq = { tool: "WebFetch", action: { kind: "network" as const, host: "example.com" } };
    expect(suggestGrant(netReq, decide(netReq, tainted), tainted)).toBeUndefined();
  });
});
