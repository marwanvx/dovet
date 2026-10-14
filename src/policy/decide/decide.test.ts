// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell text
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempProject } from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import { canonicalizePath } from "../../platform/index.ts";
import type { PermissionMode } from "../../schema/index.ts";
import { checkExamples, loadRules, type RuleSet, type Subcommand } from "../rules/index.ts";
import { analyzeShell } from "../shell-parse/analyze.ts";
import { expandGlob, isDirectory } from "../shell-parse/glob.ts";
import { loadShellParsers, type ShellLanguage, type ShellParsers } from "../shell-parse/load.ts";
import { criticalRemoval } from "./critical.ts";
import { type Decision, decide, type Env, exampleDecider, planExitChoices, type State } from "./index.ts";
import { protectedPath, sensitivePath } from "./paths.ts";

let parsers: ShellParsers;
let root = "";
let dispose: () => Promise<void>;
beforeAll(async () => {
  parsers = await loadShellParsers();
  const project = await tempProject({ "a.ts": "a", ".env": "K=1", "src/x.ts": "x" });
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
    { os, home: "/home/u", canonicalize: (p) => p },
  ).rules;
};
const state = (mode: PermissionMode, lists: Parameters<typeof rulesFor>[0] = {}, over: Partial<State> = {}): State => ({
  mode,
  rules: rulesFor(lists),
  env: env(),
  ...over,
});
const sh = (command: string, st: State, over: { language?: ShellLanguage; sandboxed?: boolean } = {}): Decision => {
  const language = over.language ?? "bash";
  const analysis = analyzeShell(parsers, language, command, {
    cwd: st.env.cwd,
    workingDirs: st.env.workingDirs,
    home: st.env.home,
    glob: expandGlob,
    isDirectory,
  });
  return decide(
    {
      tool: language === "bash" ? "Bash" : "PowerShell",
      action: { kind: "shell", analysis, sandboxed: over.sandboxed ?? false },
    },
    st,
  );
};
const file = (kind: "read" | "edit", path: string, st: State): Decision =>
  decide({ tool: kind === "read" ? "Read" : "Edit", action: { kind, paths: [path] } }, st);
const sub = (argv: string[], cwd = root): Subcommand => ({ argv, cwd });

describe("protected paths", () => {
  // spec: AC-PERM-07
  test("every protected directory and file is found at any depth", () => {
    const dirs = [
      ".git",
      ".config/git",
      ".vscode",
      ".idea",
      ".husky",
      ".cargo",
      ".devcontainer",
      ".yarn",
      ".mvn",
      ".dovet",
      ".claude",
    ];
    for (const d of dirs) expect(protectedPath(`/p/${d}/x/y`, { os: "linux" })).toBeDefined();
    const files = [
      ".gitconfig",
      ".gitmodules",
      ".bashrc",
      ".bash_profile",
      ".bash_login",
      ".bash_aliases",
      ".bash_logout",
      ".zshrc",
      ".zprofile",
      ".zshenv",
      ".zlogin",
      ".zlogout",
      ".profile",
      ".envrc",
      ".npmrc",
      ".yarnrc",
      ".yarnrc.yml",
      ".pnp.cjs",
      ".pnp.loader.mjs",
      ".pnpmfile.cjs",
      "bunfig.toml",
      ".bunfig.toml",
      ".bazelrc",
      ".bazelversion",
      ".bazeliskrc",
      ".pre-commit-config.yaml",
      "lefthook.yml",
      "lefthook.yaml",
      ".lefthook.yml",
      ".lefthook.yaml",
      "gradle-wrapper.properties",
      "maven-wrapper.properties",
      ".devcontainer.json",
      ".ripgreprc",
      "pyrightconfig.json",
      ".mcp.json",
      ".claude.json",
    ];
    for (const f of files) expect(protectedPath(`/p/sub/${f}`, { os: "linux" })).toBeDefined();
    expect(protectedPath("/p/src/gitconfig", { os: "linux" })).toBeUndefined();
    expect(protectedPath("/p/.github/workflows/ci.yml", { os: "linux" })).toBeUndefined();
    expect(protectedPath("/p/.gitignore", { os: "linux" })).toBeUndefined();
  });

  // spec: AC-PERM-07
  test("Windows and macOS spellings fold case; Dovet's own plan files are exempt", () => {
    expect(protectedPath("C:\\p\\.GIT\\config", { os: "win32" })).toBeDefined();
    expect(protectedPath("/p/.Git/config", { os: "darwin" })).toBeDefined();
    expect(protectedPath("/p/.Git/config", { os: "linux" })).toBeUndefined();
    expect(protectedPath("/p/.dovet/plans/a.md", { os: "linux", ownFiles: ["/p/.dovet/plans"] })).toBeUndefined();
    expect(protectedPath("/p/.dovet/settings.json", { os: "linux", ownFiles: ["/p/.dovet/plans"] })).toBeDefined();
  });

  // spec: AC-PERM-07
  test("a write to a protected path asks in every mode, bypassPermissions included, and is denied in dontAsk", () => {
    const target = join(root, ".git", "config");
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const)
      expect(file("edit", target, state(mode, { allow: ["Edit(**)"] })).behavior).toBe("ask");
    expect(file("edit", target, state("dontAsk", { allow: ["Edit(**)"] })).behavior).toBe("deny");
    expect(sh("echo x > .git/hooks/pre-commit", state("bypassPermissions")).behavior).toBe("ask");
    expect(sh("echo x >> .bashrc", state("acceptEdits", { allow: ["Bash(echo *)"] })).behavior).toBe("ask");
    expect(file("edit", join(root, "src", "x.ts"), state("acceptEdits")).behavior).toBe("allow");
  });
});

describe("critical paths", () => {
  const crit = (argv: string[], over: Partial<Env> = {}) => criticalRemoval({ ...env(), ...over }, sub(argv, over.cwd));

  // spec: AC-PERM-07
  test("root, its children, home in every spelling, the working directory and its parents", () => {
    const home = env().home;
    for (const t of [
      "/",
      "/*",
      "/usr",
      "/etc/",
      "~",
      "~/",
      "$HOME",
      "${HOME}",
      '"$HOME"/',
      "$HOME/*",
      "~/*",
      ".",
      "..",
      root,
      "../*",
    ])
      expect(crit(["rm", "-rf", t]), t).toBeDefined();
    expect(crit(["rm", "-rf", home])).toBeDefined();
    for (const t of ["build", "./dist", "src/x.ts", "/tmp/x", "*.o", "$HOME/proj/tmp"])
      expect(crit(["rm", "-rf", t]), t).toBeUndefined();
    expect(crit(["cat", "/"])).toBeUndefined();
  });

  // spec: AC-PERM-07
  test("variable forms: glob under a variable, positional, top-level name, substitutions", () => {
    for (const t of [
      '"$DIR"/*',
      "$DIR/",
      "$1/*",
      "${TARGET}/*",
      "$TMPDIR/mnt",
      "$(pwd)",
      "`pwd`",
      "$(git rev-parse --show-toplevel)",
      "~/$(cmd)",
      "\\",
    ])
      expect(crit(["rm", "-rf", t]), t).toBeDefined();
    expect(crit(["rm", "-rf", '"${DIR:?}"/*'])).toBeUndefined();
    expect(crit(["rm", "-rf", "$DIR/build"])).toBeUndefined();
  });

  // spec: AC-PERM-07
  test("rmdir and PowerShell Remove-Item are checked too", () => {
    expect(crit(["rmdir", "/"])).toBeDefined();
    expect(crit(["Remove-Item", "-Recurse", "-Force", "/"])).toBeDefined();
    expect(crit(["Remove-Item", "build"])).toBeUndefined();
  });

  // spec: AC-PERM-07
  test("Windows spellings: drive roots, system dirs, Git Bash and Cygwin paths, short names, UNC", () => {
    const win = {
      os: "win32" as const,
      home: "C:\\Users\\marwan",
      cwd: "C:\\work\\proj",
      workingDirs: ["C:\\work\\proj"],
      canonicalize: (p: string) => p.replace("MARWAN~1", "marwan"),
    };
    for (const t of [
      "C:\\",
      "C:/",
      "C:\\Windows",
      "c:\\windows\\",
      "\\\\?\\C:\\",
      "/c/",
      "/c/Users/marwan",
      "/cygdrive/c/Users/marwan",
      "C:\\Users\\MARWAN~1",
      "~",
      "$HOME",
      "\\\\localhost\\C$",
      "C:\\work",
      "..",
      ".",
    ])
      expect(crit(["rm", "-rf", t], win), t).toBeDefined();
    expect(crit(["rm", "-rf", "C:\\work\\proj\\build"], win)).toBeUndefined();
    expect(crit(["Remove-Item", "-Recurse", "C:\\Users\\marwan"], win)).toBeDefined();
  });

  // spec: AC-PERM-07
  test("inline bash -c scripts, subshells and substitutions are looked into, in every prompt mode", () => {
    for (const c of [
      "bash -c 'rm -rf /'",
      'sh -c "rm -rf ~"',
      "(rm -rf /usr)",
      "echo $(rm -rf /etc)",
      "true && { rm -rf /; }",
      "bash -c 'bash -c \"rm -rf /\"'",
    ]) {
      for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
        const d = sh(c, state(mode, { allow: ["Bash(*)"] }));
        expect(d.behavior, `${mode}: ${c}`).toBe("ask");
      }
      expect(sh(c, state("dontAsk", { allow: ["Bash(*)"] })).behavior).toBe("deny");
    }
    expect(sh("rm -rf /", state("bypassPermissions")).countdown).toBe(true);
    expect(sh("rm -rf /", state("default")).countdown).toBeUndefined();
  });

  // spec: AC-PERM-07
  test("a critical removal flags the whole line however the rest looks, and a sandbox never skips it", () => {
    const st = state("default", { allow: ["Bash(echo *)", "Bash(rm *)"] }, { sandboxAutoAllow: true });
    expect(sh("echo ok > ~/notes && rm -rf /", st, { sandboxed: true }).behavior).toBe("ask");
    expect(sh("rm -rf build", st, { sandboxed: true }).behavior).toBe("allow");
  });

  // spec: AC-PERM-07
  test("PowerShell Remove-Item of system paths or a bare wildcard is denied in every mode", () => {
    for (const mode of ["default", "bypassPermissions", "acceptEdits"] as const) {
      expect(sh("Remove-Item -Recurse -Force *", state(mode), { language: "powershell" }).behavior).toBe("deny");
      expect(sh("Remove-Item -Recurse /usr", state(mode), { language: "powershell" }).behavior).toBe("deny");
    }
    expect(sh("Remove-Item build", state("acceptEdits"), { language: "powershell" }).behavior).toBe("allow");
  });
});

describe("sensitive files", () => {
  // spec: AC-PERM-07
  test("the §4.7 patterns and the home credential list, with the example exceptions", () => {
    const o = { os: "linux" as const, home: "/home/u" };
    const yes = [
      "/p/.env",
      "/p/a/.env.local",
      "/p/k.pem",
      "/p/k.key",
      "/p/c.p12",
      "/p/c.pfx",
      "/p/id_rsa",
      "/p/id_rsa.pub",
      "/p/id_ed25519",
      "/p/id_ecdsa",
      "/p/.npmrc",
      "/p/.pypirc",
      "/p/.netrc",
      "/p/.git-credentials",
      "/p/credentials.json",
      "/p/my-service-account-1.json",
      "/p/a.keystore",
      "/p/.aws/credentials",
      "/p/.docker/config.json",
      "/p/secrets.yml",
      "/p/secrets.yaml",
      "/p/prod.tfvars",
      "/p/terraform.tfstate",
      "/p/terraform.tfstate.backup",
      "/home/u/.ssh/known_hosts",
      "/home/u/.aws/config",
      "/home/u/.gnupg/x",
      "/home/u/.config/gcloud/a",
      "/home/u/.azure/a",
      "/home/u/.kube/config",
    ];
    for (const p of yes) expect(sensitivePath(p, o), p).toBeDefined();
    for (const p of [
      "/p/.env.example",
      "/p/.env.sample",
      "/p/.env.template",
      "/p/.env.dist",
      "/p/environment.ts",
      "/p/src/key.ts",
      "/home/u/.kube/other",
      "/p/README.md",
    ])
      expect(sensitivePath(p, o), p).toBeUndefined();
    expect(sensitivePath("/p/internal.secret", { ...o, sensitiveFiles: ["**/*.secret"] })).toBeDefined();
  });

  // spec: AC-PERM-07
  test("Read, Edit and shell reads of a sensitive file ask in every mode but bypassPermissions; dontAsk denies", () => {
    const env1 = join(root, ".env");
    expect(file("read", env1, state("default")).behavior).toBe("ask");
    expect(file("read", env1, state("acceptEdits")).behavior).toBe("ask");
    expect(file("edit", env1, state("acceptEdits")).behavior).toBe("ask");
    expect(file("read", env1, state("dontAsk")).behavior).toBe("deny");
    expect(file("read", env1, state("bypassPermissions")).behavior).toBe("allow");
    expect(sh("cat .env", state("default")).behavior).toBe("ask");
    expect(sh("cat .env", state("default", { allow: ["Bash(cat *)"] })).behavior).toBe("ask");
    expect(file("read", env1, state("default", { allow: [`Read(/${env1})`] })).behavior).toBe("allow");
    expect(file("read", env1, state("default", { deny: ["Read(.env)"] })).behavior).toBe("deny");
    expect(file("read", join(root, "a.ts"), state("default")).behavior).toBe("allow");
  });

  // spec: AC-PERM-07
  test("a shell write to a file the file tools would refuse asks even under a whole-tool Bash allow", () => {
    expect(sh("echo K=1 > .env", state("acceptEdits", { allow: ["Bash"] })).behavior).toBe("ask");
    expect(sh("echo K=1 > ~/.ssh/authorized_keys", state("default", { allow: ["Bash"] })).behavior).toBe("ask");
  });
});

describe("working directories and network paths", () => {
  // spec: AC-PERM-07
  test("reads and writes outside the working directories ask; an allow path rule approves; blocking refuses", () => {
    const out = join(root, "..", "elsewhere.txt");
    expect(file("read", out, state("default")).behavior).toBe("ask");
    expect(file("read", out, state("default")).reason).toContain("outside working directory");
    expect(file("edit", out, state("acceptEdits")).behavior).toBe("ask");
    expect(file("read", out, state("default", { allow: [`Read(/${join(root, "..")}/**)`] })).behavior).toBe("allow");
    const blocked = state("bypassPermissions", {}, { blockReadsOutsideWorkingDirectories: true });
    expect(file("read", out, blocked).behavior).toBe("deny");
    expect(file("read", out, state("bypassPermissions")).behavior).toBe("allow");
  });

  // spec: AC-PERM-07
  test("UNC paths are refused by file tools in every mode and ask in shell commands", () => {
    const st = (mode: PermissionMode): State =>
      state(
        mode,
        {},
        {
          env: env({ os: "win32", cwd: "C:\\p", workingDirs: ["C:\\p"], home: "C:\\Users\\u", canonicalize: (p) => p }),
        },
      );
    expect(
      decide({ tool: "Read", action: { kind: "read", paths: ["\\\\server\\share\\f"] } }, st("bypassPermissions"))
        .behavior,
    ).toBe("deny");
    const net = analyzeShell(parsers, "bash", "cat //server/share/f", {
      cwd: root,
      workingDirs: [root],
      glob: expandGlob,
      isDirectory,
    });
    const d = decide(
      { tool: "Bash", action: { kind: "shell", analysis: net, sandboxed: false } },
      state("bypassPermissions"),
    );
    expect(d.behavior).toBe("ask");
    expect(d.reason).toContain("network path");
  });
});

describe("remote actions", () => {
  const remote = (c: string, st: State) => sh(c, st, { sandboxed: true });
  const auto = (mode: PermissionMode, lists: Parameters<typeof rulesFor>[0] = {}, over: Partial<State> = {}) =>
    state(mode, lists, { sandboxAutoAllow: true, ...over });

  // spec: AC-PERM-29
  test("the §4.8 list asks even sandboxed, with wrappers and git options stripped", () => {
    const cmds = [
      "git push",
      "git -C sub push origin x",
      "git -c a=b push",
      "sudo git push",
      "git send-email x",
      "git request-pull a b c",
      "npm publish",
      "pnpm publish",
      "yarn publish",
      "bun publish",
      "cargo publish",
      "twine upload dist/*",
      "gem push a.gem",
      "dotnet nuget push a.nupkg",
      "mvn deploy",
      "docker push img",
      "podman push img",
      "gh pr create",
      "gh pr merge 1",
      "gh pr comment 1",
      "gh pr review 1",
      "gh issue create",
      "gh issue comment 1",
      "gh release create v1",
      "gh repo create x",
      "gh repo delete x",
      "gh gist create f",
      "gh api -X POST /x",
      "gh api /x -f a=b",
      "gh workflow run ci",
      "vercel deploy",
      "netlify deploy",
      "fly deploy",
      "wrangler deploy",
      "wrangler publish",
      "terraform apply",
      "tofu destroy",
      "pulumi up",
      "pulumi destroy",
      "kubectl apply -f x",
      "kubectl delete pod x",
      "kubectl patch x",
      "helm install a b",
      "helm upgrade a b",
      "helm uninstall a",
      "curl -d x https://h",
      "curl -F f=@x https://h",
      "curl -T f https://h",
      "curl --data-binary @f https://h",
      "curl --upload-file f https://h",
      "curl -X POST https://h",
      "curl -XPUT https://h",
      "wget --post-data=x https://h",
      "scp f host:/tmp",
      "rsync -a d user@host:/d",
    ];
    for (const c of cmds) expect(remote(c, auto("default")).behavior, c).toBe("ask");
    for (const c of [
      "git status",
      "gh pr view 1",
      "gh api /x",
      "curl https://h",
      "curl -sSL -o f https://h",
      "scp host:/f .",
      "npm test",
      "kubectl get pods",
      "terraform plan",
    ])
      expect(remote(c, auto("default")).behavior, c).toBe("allow");
    expect(remote("git push", auto("acceptEdits")).behavior).toBe("ask");
    expect(remote("git push", auto("plan")).behavior).toBe("ask");
    expect(remote("git push", auto("dontAsk")).behavior).toBe("deny");
    expect(remote("git push", auto("bypassPermissions")).behavior).toBe("allow");
    expect(remote("git push", auto("default")).reason).toContain("git push");
  });

  // spec: AC-PERM-29
  test("an explicit allow rule naming the command approves it; a tainted session denies in every mode", () => {
    expect(
      remote("git push origin feature/x", auto("default", { allow: ["Bash(git push origin feature/*)"] })).behavior,
    ).toBe("allow");
    expect(
      remote("git push origin other", auto("default", { allow: ["Bash(git push origin feature/*)"] })).behavior,
    ).toBe("ask");
    expect(
      remote("git status && git push origin main", auto("default", { allow: ["Bash(git status)"] })).behavior,
    ).toBe("ask");
    for (const mode of ["default", "bypassPermissions", "dontAsk"] as const)
      expect(remote("git push", auto(mode, { allow: ["Bash(git push)"] }, { tainted: true })).behavior).toBe("deny");
  });

  // spec: AC-PERM-29
  test("force-push to the default branch is denied unless an exact rule names the command", () => {
    for (const c of [
      "git push --force origin main",
      "git push -f origin main",
      "git push --force-with-lease origin master",
      "git push origin +main",
      "git push --force origin HEAD:main",
    ])
      for (const mode of ["default", "bypassPermissions"] as const)
        expect(remote(c, auto(mode, { allow: ["Bash(git push *)"] })).behavior, c).toBe("deny");
    expect(
      remote("git push --force origin main", auto("default", { allow: ["Bash(git push --force origin main)"] }))
        .behavior,
    ).toBe("allow");
    expect(remote("git push --force origin feature", auto("default")).behavior).toBe("ask");
    expect(remote("git push --force origin trunk", auto("default", {}, { defaultBranch: "trunk" })).behavior).toBe(
      "deny",
    );
  });

  // spec: AC-PERM-29
  test("permissions.examples go through the built-in checks and name the decider", () => {
    const rules = rulesFor({ allow: ["Bash(git status)"] });
    const decider = exampleDecider(
      state("default", { allow: ["Bash(git status)"] }, { sandboxAutoAllow: true }),
      parsers,
    );
    const ok = checkExamples(rules, [{ Bash: "git push --force origin main", expect: "deny" }], { decide: decider });
    expect(ok).toEqual([]);
    const bad = checkExamples(rules, [{ Bash: "git status && git push origin main", expect: "allow" }], {
      decide: decider,
    });
    expect(bad).toHaveLength(1);
    expect(bad[0]?.message).toContain("remote action: git push");
    expect(bad[0]?.message).toContain("remote-action check (§4.8)");
  });
});

describe("self-protection", () => {
  // spec: AC-PERM-07
  test("killing Dovet's own pid or parent is denied; broad pkill patterns ask with a warning", () => {
    const st = state("bypassPermissions");
    expect(sh("kill 4242", st).behavior).toBe("deny");
    expect(sh("kill -9 4241", st).behavior).toBe("deny");
    expect(sh("taskkill /PID 4242 /F", st).behavior).toBe("deny");
    expect(sh("pkill -f dovet", st).behavior).toBe("ask");
    expect(sh("pkill -f dovet", st).reason).toContain("Dovet");
    expect(sh("killall bun", st).behavior).toBe("ask");
    expect(sh("Stop-Process -Name dovet", st, { language: "powershell" }).behavior).toBe("ask");
    expect(sh("pkill -f myserver", state("default", { allow: ["Bash(pkill *)"] })).behavior).toBe("allow");
  });
});

describe("modes", () => {
  // spec: AC-PERM-17
  test("in plan mode no allow rule, sandbox or edit rule permits a write and touch prompts", () => {
    const st = state("plan", { allow: ["Edit(src/**)", "Bash(touch *)"] }, { sandboxAutoAllow: true });
    expect(file("edit", join(root, "src", "x.ts"), st).behavior).toBe("deny");
    expect(sh("touch x", st, { sandboxed: true }).behavior).toBe("ask");
    expect(sh("ls", st).behavior).toBe("allow");
    expect(file("read", join(root, "a.ts"), st).behavior).toBe("allow");
    const plan = join(root, ".dovet", "plans", "p.md");
    const own = state("plan", {}, { env: env({ planFile: plan, ownFiles: [join(root, ".dovet", "plans")] }) });
    expect(file("edit", plan, own).behavior).toBe("allow");
  });

  // spec: AC-PERM-17
  test("a write to .git/config prompts in bypassPermissions; bypass otherwise allows, dontAsk never prompts", () => {
    expect(file("edit", join(root, ".git", "config"), state("bypassPermissions")).behavior).toBe("ask");
    expect(sh("npm install", state("bypassPermissions")).behavior).toBe("allow");
    expect(sh("npm install", state("dontAsk")).behavior).toBe("deny");
    expect(sh("ls", state("dontAsk")).behavior).toBe("allow");
    expect(file("edit", join(root, "a.ts"), state("dontAsk", { allow: ["Edit(a.ts)"] })).behavior).toBe("allow");
    expect(file("edit", join(root, "a.ts"), state("dontAsk")).behavior).toBe("deny");
  });

  // spec: AC-PERM-17
  test("Manual asks for edits (as a review) and unknown commands; acceptEdits allows edits and filesystem commands in scope", () => {
    expect(file("edit", join(root, "a.ts"), state("default")).behavior).toBe("ask");
    expect(file("edit", join(root, "a.ts"), state("default")).reason).toContain("Review edit");
    expect(sh("npm install", state("default")).behavior).toBe("ask");
    for (const c of [
      "mkdir out",
      "touch a.ts",
      "rm a.ts",
      "rmdir out",
      "mv a.ts b.ts",
      "cp a.ts c.ts",
      "sed -i s/a/b/ a.ts",
      "echo x > out.txt",
    ])
      expect(sh(c, state("acceptEdits")).behavior, c).toBe("allow");
    expect(sh("rm ../x", state("acceptEdits")).behavior).toBe("ask");
    expect(sh("npm install", state("acceptEdits")).behavior).toBe("ask");
    expect(sh("Set-Content a.ts hi", state("acceptEdits"), { language: "powershell" }).behavior).toBe("allow");
  });

  // spec: AC-PERM-17
  test("a sandboxed command is free in Manual with auto-allow on, but not in plan, and not when unparseable names", () => {
    const st = state("default", {}, { sandboxAutoAllow: true });
    expect(sh("npm install", st, { sandboxed: true }).behavior).toBe("allow");
    expect(sh("npm install", st, { sandboxed: false }).behavior).toBe("ask");
    expect(sh("$CMD install", st, { sandboxed: true }).behavior).toBe("ask");
  });

  // spec: AC-PERM-17
  test("deny rules always win, an ask rule asks even in bypassPermissions, and interactions never auto-approve", () => {
    expect(sh("rm build", state("bypassPermissions", { deny: ["Bash(rm *)"] })).behavior).toBe("deny");
    expect(sh("git status && ls", state("bypassPermissions", { ask: ["Bash(git status)"] })).behavior).toBe("ask");
    expect(
      decide({ tool: "AskUserQuestion", action: { kind: "interaction" } }, state("bypassPermissions")).behavior,
    ).toBe("ask");
    expect(decide({ tool: "ExitPlanMode", action: { kind: "interaction" } }, state("bypassPermissions")).behavior).toBe(
      "ask",
    );
    expect(decide({ tool: "TodoWrite", action: { kind: "task-list" } }, state("plan")).behavior).toBe("allow");
  });

  // spec: AC-PERM-17
  test("a command that could not be parsed or understood is never allowed by a prefix rule", () => {
    expect(sh("echo $(", state("default", { allow: ["Bash(echo *)"] })).behavior).toBe("ask");
    const long = `echo ${"a".repeat(10_001)}`;
    expect(sh(long, state("default", { allow: ["Bash(echo *)"] })).behavior).toBe("ask");
  });

  test("WebFetch asks for a new domain, honors domain rules, and bypass allows it", () => {
    const fetch = (st: State) => decide({ tool: "WebFetch", action: { kind: "network", host: "example.com" } }, st);
    expect(fetch(state("default")).behavior).toBe("ask");
    expect(fetch(state("default", { allow: ["WebFetch(domain:example.com)"] })).behavior).toBe("allow");
    expect(fetch(state("default", { deny: ["WebFetch(domain:example.com)"] })).behavior).toBe("deny");
    expect(fetch(state("bypassPermissions")).behavior).toBe("allow");
  });
});

describe("bypass corpus through the full decision", () => {
  // spec: AC-PERM-20
  test("in default and acceptEdits with the entry's own rules, no entry is auto-approved", async () => {
    const lines = (await Bun.file(join(import.meta.dir, "..", "testdata", "bypass-corpus.jsonl")).text()).split("\n");
    const approved: string[] = [];
    for (const line of lines.filter((l) => l.trim() !== "")) {
      const e = JSON.parse(line) as { language: ShellLanguage; command: string; allow?: string[]; deny?: string[] };
      for (const mode of ["default", "acceptEdits"] as const) {
        if (mode === "acceptEdits" && e.command === "Remove-Item -Recurse build") continue; // allowed in scope by design (§2)
        const st = state(mode, { allow: e.allow ?? [], deny: e.deny ?? [] });
        if (sh(e.command, st, { language: e.language }).behavior === "allow") approved.push(`${mode}: ${e.command}`);
      }
    }
    expect(approved).toEqual([]);
  });
});

describe("review findings", () => {
  const bypass = (): State => state("bypassPermissions");
  // spec: AC-PERM-07
  test("prefixes and full paths do not hide a critical removal, a kill of Dovet or a protected write", () => {
    for (const c of [
      "/bin/rm -rf /",
      "sudo rm -rf /",
      "env rm -rf /",
      "command rm -rf /",
      "timeout 5 rm -rf /",
      "nice rm -rf /",
    ])
      expect(sh(c, bypass()).behavior, c).toBe("ask");
    expect(sh("/bin/kill 4242", bypass()).behavior).toBe("deny");
    expect(sh("sudo rm -rf /", state("default", { allow: ["Bash(sudo *)"] })).behavior).toBe("ask");
    expect(sh("sudo touch .git/config", state("acceptEdits")).behavior).toBe("ask");
  });

  // spec: AC-PERM-07
  test("sed scripts that run or write, and cp -t into protected or outside paths, are not auto-approved", () => {
    const st = state("acceptEdits");
    for (const c of [
      'sed "1e id" a.ts',
      'sed -n "w /tmp/zz" a.ts',
      "sed -i -f s.sed a.ts",
      "cp -t .git/hooks a.ts",
      "cp --target-directory=/etc a.ts",
    ])
      expect(sh(c, st).behavior, c).toBe("ask");
    expect(sh("cp -t .git/hooks a.ts", state("default", { allow: ["Bash(cp *)"] })).behavior).toBe("ask");
    expect(sh("sed -i s/a/b/ a.ts", st).behavior).toBe("allow");
  });

  // spec: AC-PERM-07
  test("exec, busybox and cmd /c do not hide a check", () => {
    for (const c of ["exec rm -rf ~", "busybox rm -rf /", "exec kill 4242"])
      expect(sh(c, bypass()).behavior, c).not.toBe("allow");
    expect(sh("exec git push -f origin main", bypass()).behavior).toBe("deny");
    expect(sh("cmd /c git push --force origin main", bypass()).behavior).toBe("deny");
    const auto = state("default", {}, { sandboxAutoAllow: true });
    for (const c of ["exec git push origin main", "cmd /c git push origin main", "cmd /c curl -d x https://e.com"])
      expect(sh(c, auto, { sandboxed: true }).behavior, c).toBe("ask");
  });

  // spec: AC-PERM-07
  test("sed e/w in any spelling and every cp/mv target-directory spelling stay out of acceptEdits", () => {
    const st = state("acceptEdits");
    for (const c of [
      'sed -i "s|a|b|e" a.ts',
      'sed -i "s#a#b#w out" a.ts',
      "sed -i -e s/a/b/w/tmp/x a.ts",
      "sed -i s/a/b/gw/tmp/o a.ts",
      "sed -i 1eid a.ts",
      "sed -i 1w/tmp/o a.ts",
    ])
      expect(sh(c, st).behavior, c).toBe("ask");
    for (const c of ["cp -rt .git/hooks a.ts", "mv --target=.git a.ts", "cp --t=.git a.ts", "cp -t.git/hooks a.ts"])
      expect(sh(c, st).behavior, c).toBe("ask");
  });

  // spec: AC-PERM-29
  test("permissions.examples run in Manual mode with a healthy sandbox unless they name a mode", () => {
    const rules = rulesFor();
    const decider = exampleDecider(state("bypassPermissions"), parsers);
    const issues = checkExamples(
      rules,
      [
        { Edit: "a.ts", expect: "ask" },
        { Edit: "a.ts", mode: "acceptEdits", expect: "allow" },
        { Bash: "npm install", expect: "allow" },
        { Bash: "git push", expect: "ask" },
      ],
      { decide: decider, cwd: root },
    );
    expect(issues).toEqual([]);
  });

  // spec: AC-PERM-07
  test("tee behind a wrapper is a write to its file", () => {
    for (const c of [
      "sudo tee .git/config",
      "timeout 5 tee .git/config",
      "nice tee .bashrc",
      "cat a.ts | sudo tee .git/config",
    ])
      expect(sh(c, bypass()).behavior, c).toBe("ask");
    expect(sh("nice tee .env", state("default", { allow: ["Bash"] })).behavior).toBe("ask");
  });

  // spec: AC-PERM-29
  test("git options with values, gh api and curl spellings, and wildcard rules for force-push", () => {
    for (const c of ["git --config-env a=b push -f origin main", "git --attr-source HEAD push -f origin main"])
      expect(sh(c, bypass()).behavior, c).toBe("deny");
    for (const c of ["gh api -XPOST /x", "gh api -fa=b /x", "gh api --field=a=b /x", "curl -sX POST https://h"]) {
      expect(sh(c, state("default", {}, { sandboxAutoAllow: true }), { sandboxed: true }).behavior, c).toBe("ask");
      expect(sh(c, state("bypassPermissions", {}, { tainted: true })).behavior, c).toBe("deny");
    }
    const st = state("default", { allow: ["Bash(git push*)", "Bash(git -C *)"] }, { sandboxAutoAllow: true });
    expect(sh("git push --mirror origin", st, { sandboxed: true }).behavior).toBe("deny");
    expect(sh("git -C . push origin main", st, { sandboxed: true }).behavior).toBe("ask");
  });

  // spec: AC-PERM-29
  test("options before the subcommand and a full path do not hide a remote action", () => {
    for (const c of [
      "kubectl -n prod apply -f x.yaml",
      "gh -R o/r pr create",
      "npm --registry https://r publish",
      "pnpm -r publish",
      "terraform -chdir=infra apply",
      "/usr/bin/git push",
    ])
      expect(sh(c, state("default", {}, { sandboxAutoAllow: true }), { sandboxed: true }).behavior, c).toBe("ask");
  });

  // spec: AC-PERM-29
  test("only a rule that names the command lifts a remote action; Bash(git *) does not", () => {
    const st = (allow: string) => state("default", { allow: [allow] }, { sandboxAutoAllow: true });
    for (const rule of ["Bash", "Bash(*)", "Bash(git *)", "Bash(g*)"])
      expect(sh("git push origin main", st(rule), { sandboxed: true }).behavior, rule).toBe("ask");
    expect(sh("git push origin main", st("Bash(git push*)"), { sandboxed: true }).behavior).toBe("allow");
  });

  // spec: AC-PERM-07
  test("a broad Read or Edit allow does not lift a sensitive file; only its exact path does", () => {
    expect(file("read", join(root, ".env"), state("default", { allow: ["Read(**)"] })).behavior).toBe("ask");
    expect(file("edit", join(root, ".env"), state("acceptEdits", { allow: ["Edit(**)"] })).behavior).toBe("ask");
    expect(sh("cat .env", state("default", { allow: ["Read(**)"] })).behavior).toBe("ask");
  });

  // spec: AC-PERM-29
  test("a force-push with no branch named, or HEAD, counts as the default branch", () => {
    for (const c of ["git push --force", "git push -f origin", "git push -f origin HEAD"])
      expect(sh(c, bypass()).behavior, c).toBe("deny");
    expect(sh("git push --force origin feature", bypass()).behavior).toBe("allow");
  });

  // spec: AC-PERM-07
  test("$HOME with more expansion after it is critical", () => {
    for (const c of ["rm -rf $HOME$X", "rm -rf ${HOME%/}"]) expect(sh(c, bypass()).behavior, c).toBe("ask");
  });

  // spec: AC-PERM-07
  test("cmd /c rd and del on system paths are denied; macOS /private paths and unresolved write targets are caught", () => {
    const win = state(
      "default",
      {},
      { env: env({ os: "win32", cwd: "C:\\p", workingDirs: ["C:\\p"], home: "C:\\Users\\u", canonicalize: (p) => p }) },
    );
    const sub1 = { argv: ["cmd", "/c", "rd /s C:\\Windows"], cwd: "C:\\p" };
    expect(
      decide(
        {
          tool: "Bash",
          action: {
            kind: "shell",
            analysis: { commands: [sub1], understood: true, literalNames: true, reasons: [], operands: [] },
            sandboxed: false,
          },
        },
        win,
      ).behavior,
    ).toBe("deny");
    const mac = env({ os: "darwin", canonicalize: (p) => p });
    for (const t of ["/private/etc", "/private/var", "/private/tmp", "/private/home"])
      expect(criticalRemoval(mac, sub(["rm", "-rf", t])), t).toBeDefined();
    expect(sh("rm *.o", state("acceptEdits")).behavior).toBe("ask");
    expect(sh("rmdir /usr", state("default", { allow: ["Bash(rmdir *)"] })).behavior).toBe("ask");
  });

  // spec: AC-PERM-17
  test("leaving plan mode offers the mode from before plan first, never a lower one", () => {
    expect(planExitChoices("bypassPermissions")[0]).toBe("bypassPermissions");
    expect(planExitChoices("acceptEdits")[0]).toBe("acceptEdits");
    expect(planExitChoices("plan")[0]).toBe("default");
  });

  // spec: AC-PERM-07
  test("a sandboxed read outside the working directories is free, but a sensitive one still asks", () => {
    const st = state("default", {}, { sandboxAutoAllow: true });
    expect(sh("cat ../x", st, { sandboxed: true }).behavior).toBe("allow");
    expect(sh("cat ~/.ssh/id_rsa", st, { sandboxed: true }).behavior).toBe("ask");
  });
});
