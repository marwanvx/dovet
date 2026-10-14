import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Os } from "../../platform/index.ts";
import { canonicalizePath } from "../../platform/index.ts";
import {
  checkExamples,
  evaluateRules,
  loadRules,
  type RuleCall,
  type RuleContext,
  type RuleMatch,
  type RuleSource,
  ruleTexts,
  splitCommand,
} from "./index.ts";

const texts = (xs: string[] = []) => xs.map((text) => ({ text }));

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return { os: "linux", home: "/home/u", canonicalize: (p) => p, ...over };
}

function load(
  lists: { allow?: string[]; ask?: string[]; deny?: string[] },
  over: Partial<RuleContext> = {},
  file = "/p/.dovet/settings.json",
  baseDir = "/p",
) {
  const source: RuleSource = {
    file,
    baseDir,
    allow: texts(lists.allow),
    ask: texts(lists.ask),
    deny: texts(lists.deny),
  };
  return loadRules([source], ctx(over));
}

const bash = (command: string, cwd = "/p"): RuleCall => {
  const commands = splitCommand(command);
  return { tool: "Bash", cwd, ...(commands === undefined ? {} : { commands }) };
};
const decide = (r: ReturnType<typeof load>, call: RuleCall): string | undefined => {
  const m: RuleMatch | undefined = evaluateRules(r.rules, call);
  return m === undefined ? undefined : `${m.behavior}:${m.rule}`;
};
const read = (path: string, access: "read" | "edit" = "read", cwd = "/p"): RuleCall => ({
  tool: access === "read" ? "Read" : "Edit",
  cwd,
  paths: [{ access, path }],
});

describe("shell rule grammar", () => {
  // spec: AC-PERM-01
  test("the wildcard rows match exactly as specified", () => {
    const allowed = (rule: string, command: string) => decide(load({ allow: [rule] }), bash(command)) !== undefined;
    expect(allowed("Bash(npm run *)", "npm run build")).toBe(true);
    expect(allowed("Bash(npm run *)", "npm run")).toBe(true);
    expect(allowed("Bash(npm run *)", "npm running")).toBe(false);
    expect(allowed("Bash(git log * main)", "git log --oneline main")).toBe(true);
    expect(allowed("Bash(git log * main)", "git log main")).toBe(false);
    expect(allowed("Bash(* --version)", "node --version")).toBe(true);
    expect(allowed("Bash(* --version)", "node -v")).toBe(false);
    expect(allowed("Bash(ls *)", "ls")).toBe(true);
    expect(allowed("Bash(ls *)", "ls -la /tmp")).toBe(true);
    expect(allowed("Bash(ls *)", "lsof")).toBe(false);
    expect(allowed("Bash(ls*)", "lsof")).toBe(true);
    expect(allowed("Bash(git status)", "git status")).toBe(true);
    expect(allowed("Bash(git status)", "git status -s")).toBe(false);
    expect(allowed("Bash(*)", "anything at all")).toBe(true);
    expect(allowed("Bash", "anything at all")).toBe(true);
  });

  // spec: AC-PERM-01
  test("a * matches spaces, text before the first * is literal, and :* means ' *' with a warning", () => {
    const r = load({ allow: ["Bash(npm:*)", "Bash(git * main)"] });
    expect(decide(r, bash("npm install left pad"))).toBe("allow:Bash(npm:*)");
    expect(decide(r, bash("npm"))).toBe("allow:Bash(npm:*)");
    expect(decide(r, bash("npmx"))).toBeUndefined();
    const warnings = r.issues.filter((i) => i.severity === "warning").map((i) => i.message);
    expect(warnings.some((m) => m.includes("Bash(npm:*)") && m.includes("npm *"))).toBe(true);
    expect(warnings.some((m) => m.includes("Bash(git * main)") && m.includes("before the subcommand"))).toBe(true);
    expect(load({ allow: ["Bash(git log *)"] }).issues).toEqual([]);
  });

  // spec: AC-PERM-01
  test("deny, then ask, then allow: the first match wins whatever the specificity", () => {
    const r = load({ allow: ["Bash(aws s3 ls)", "Bash(git commit *)"], ask: ["Bash(git *)"], deny: ["Bash(aws *)"] });
    expect(decide(r, bash("aws s3 ls"))).toBe("deny:Bash(aws *)");
    expect(decide(r, bash("git commit -m x"))).toBe("ask:Bash(git *)");
  });

  // spec: AC-PERM-01
  test("a compound command needs every subcommand allowed, and any denied one denies", () => {
    const r = load({ allow: ["Bash(echo *)"], deny: ["Bash(rm *)"] });
    expect(decide(r, bash("echo ok && echo more"))).toBe("allow:Bash(echo *)");
    expect(decide(r, bash("echo ok && git push"))).toBeUndefined();
    expect(decide(r, bash("echo ok && rm -rf build"))).toBe("deny:Bash(rm *)");
    expect(decide(r, bash("echo ok &&"))).toBeUndefined();
  });

  // spec: AC-PERM-01
  test("a bare tool name in deny blocks every call; deny and ask take globs, allow only after mcp__server__", () => {
    const r = load({ deny: ["WebFetch", "mcp__evil__*"], allow: ["mcp__good__*", "mcp__*", "Rea*"] });
    expect(decide(r, { tool: "WebFetch", cwd: "/p", host: "example.com" })).toBe("deny:WebFetch");
    expect(decide(r, { tool: "mcp__evil__run", cwd: "/p" })).toBe("deny:mcp__evil__*");
    expect(decide(r, { tool: "mcp__good__run", cwd: "/p" })).toBe("allow:mcp__good__*");
    expect(decide(r, { tool: "mcp__other__run", cwd: "/p" })).toBeUndefined();
    expect(r.issues.filter((i) => i.message.includes("glob")).length).toBe(2);
  });

  // spec: AC-PERM-01
  test("parameter rules match a scalar input in deny and ask; a primary field is rejected", () => {
    const toolParams = new Map([["Bash", new Set(["dangerouslyDisableSandbox"])]]);
    const r = load(
      {
        deny: ["Bash(dangerouslyDisableSandbox:true)", "Bash(command:rm *)"],
        allow: ["Bash(dangerouslyDisableSandbox:true)"],
      },
      { toolParams },
    );
    const call: RuleCall = {
      tool: "Bash",
      cwd: "/p",
      input: { command: "ls", dangerouslyDisableSandbox: true },
      commands: splitCommand("ls") ?? [],
    };
    expect(decide(r, call)).toBe("deny:Bash(dangerouslyDisableSandbox:true)");
    expect(decide(r, { ...call, input: { command: "ls", dangerouslyDisableSandbox: false } })).toBeUndefined();
    expect(r.issues.filter((i) => i.severity === "warning").length).toBe(2);
    expect(decide(r, bash("rm x"))).toBeUndefined();
  });
});

describe("path rules", () => {
  // spec: AC-PERM-05
  test("the four anchors resolve against the filesystem root, home, the settings source and the cwd", () => {
    const r = load(
      { deny: ["Read(//etc/hosts)", "Read(~/.ssh/**)", "Read(/secret/**)", "Read(vault/**)", "Read(./top.txt)"] },
      {},
      "/p/.dovet/settings.json",
      "/p",
    );
    expect(decide(r, read("/etc/hosts"))).toBe("deny:Read(//etc/hosts)");
    expect(decide(r, read("/home/u/.ssh/id_rsa"))).toBe("deny:Read(~/.ssh/**)");
    expect(decide(r, read("/p/secret/a"))).toBe("deny:Read(/secret/**)");
    expect(decide(r, read("/other/secret/a"))).toBeUndefined();
    expect(decide(r, read("/p/vault/a"))).toBe("deny:Read(vault/**)");
    expect(decide(r, read("/p/top.txt"))).toBe("deny:Read(./top.txt)");
    expect(decide(r, read("/p/sub/top.txt"))).toBeUndefined();
    const user = load({ deny: ["Read(/keys/**)"] }, {}, "/home/u/.config/dovet/settings.json", "/home/u/.config/dovet");
    expect(decide(user, read("/home/u/.config/dovet/keys/a"))).toBe("deny:Read(/keys/**)");
    expect(decide(user, read("/p/keys/a"))).toBeUndefined();
  });

  // spec: AC-PERM-05
  test("a single-segment directory pattern is anchored in allow and floats in deny and ask", () => {
    const r = load({ allow: ["Edit(src/**)"] });
    expect(decide(r, read("/p/src/a.ts", "edit"))).toBe("allow:Edit(src/**)");
    expect(decide(r, read("/p/pkg/src/a.ts", "edit"))).toBeUndefined();
    const d = load({ deny: ["Edit(src/**)"], ask: ["Edit(lib/)"] });
    expect(decide(d, read("/p/pkg/src/a.ts", "edit"))).toBe("deny:Edit(src/**)");
    expect(decide(d, read("/p/a/lib/x", "edit"))).toBe("ask:Edit(lib/)");
    const bare = load({ deny: ["Read(.env)"] });
    expect(decide(bare, read("/p/a/b/.env"))).toBe("deny:Read(.env)");
    expect(decide(bare, read("/elsewhere/.env"))).toBe("deny:Read(.env)");
  });

  // spec: AC-PERM-05
  test("a Read deny also blocks edits, an Edit rule covers Edit and Write, a Read allow does not allow edits", () => {
    const r = load({ deny: ["Read(/no/**)"], allow: ["Read(/ok/**)", "Edit(/ed/**)"] });
    expect(decide(r, read("/p/no/a", "edit"))).toBe("deny:Read(/no/**)");
    expect(decide(r, read("/p/ok/a", "edit"))).toBeUndefined();
    expect(decide(r, read("/p/ed/a", "edit"))).toBe("allow:Edit(/ed/**)");
    expect(decide(r, { ...read("/p/ed/a", "edit"), tool: "Write" })).toBe("allow:Edit(/ed/**)");
    const w = load({ deny: ["Write(/x/**)", "Glob(/y)"] });
    expect(w.issues.filter((i) => i.message.includes("Edit")).length).toBe(1);
    expect(w.issues.filter((i) => i.message.includes("Read")).length).toBe(1);
  });

  // spec: AC-PERM-05
  test("! negation in deny re-includes a path, but only against earlier rules of the same source", () => {
    const sameFile = load({ deny: ["Read(/logs/**)", "Read(!/logs/public/**)"] });
    expect(decide(sameFile, read("/p/logs/a"))).toBe("deny:Read(/logs/**)");
    expect(decide(sameFile, read("/p/logs/public/a"))).toBeUndefined();
    const sources: RuleSource[] = [
      { file: "/a.json", baseDir: "/p", deny: texts(["Read(/logs/**)"]) },
      { file: "/b.json", baseDir: "/p", deny: texts(["Read(!/logs/public/**)"]) },
    ];
    const two = loadRules(sources, ctx());
    expect(decide(two, read("/p/logs/public/a"))).toBe("deny:Read(/logs/**)");
    expect(load({ allow: ["Read(!/x)"] }).issues.length).toBe(1);
  });

  // spec: AC-PERM-05
  test("on Windows, backslashes, drive letters in either case and a drive root work, case-insensitively", () => {
    const os: Os = "win32";
    const wctx = { os, home: "C:\\Users\\a", canonicalize: (p: string) => p };
    const run = (rule: string, path: string) =>
      decide(
        loadRules([{ file: "C:\\p\\s.json", baseDir: "C:\\p", deny: texts([rule]) }], wctx),
        read(path, "read", "C:\\p"),
      );
    expect(run("Read(~\\Documents\\**)", "c:\\USERS\\A\\documents\\x.txt")).toBe("deny:Read(~\\Documents\\**)");
    expect(run("Read(C:\\Windows\\**)", "c:\\windows\\system32\\a.dll")).toBe("deny:Read(C:\\Windows\\**)");
    expect(run("Read(c:\\Windows\\**)", "C:\\WINDOWS\\a")).toBe("deny:Read(c:\\Windows\\**)");
    expect(run("Read(//c/Users/a/.ssh/**)", "C:\\Users\\a\\.ssh\\id")).toBe("deny:Read(//c/Users/a/.ssh/**)");
    expect(run("Read(C:\\**)", "D:\\other")).toBeUndefined();
    expect(run("Read(C:\\**)", "C:\\anything\\at\\all")).toBe("deny:Read(C:\\**)");
    expect(run("Read(/keys/**)", "C:\\p\\keys\\a")).toBe("deny:Read(/keys/**)");
  });
});

describe("symlinks", () => {
  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dovet-rules-")));
    mkdirSync(join(root, "p", "docs"), { recursive: true });
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "f.txt"), "x");
    writeFileSync(join(root, "p", "docs", "real.txt"), "x");
    symlinkSync(join(root, "outside", "f.txt"), join(root, "p", "docs", "link.txt"));
    const canonicalize = (p: string) => canonicalizePath(p, "/", "linux");
    return { root, p: join(root, "p"), canonicalize };
  }

  // spec: AC-PERM-06
  test("allow needs both the requested path and its target allowed", () => {
    const { p, canonicalize } = fixture();
    const r = load({ allow: ["Read(/docs/**)"] }, { canonicalize }, join(p, "s.json"), p);
    expect(decide(r, read(join(p, "docs", "real.txt"), "read", p))).toBe("allow:Read(/docs/**)");
    expect(decide(r, read(join(p, "docs", "link.txt"), "read", p))).toBeUndefined();
  });

  // spec: AC-PERM-06
  test("deny needs either: the spelling or where the link lands", () => {
    const { root, p, canonicalize } = fixture();
    const byTarget = load({ deny: [`Read(/${join(root, "outside")}/**)`] }, { canonicalize }, join(p, "s.json"), p);
    expect(decide(byTarget, read(join(p, "docs", "link.txt"), "read", p))).toContain("deny:");
    const bySpelling = load({ deny: ["Read(/docs/link.txt)"] }, { canonicalize }, join(p, "s.json"), p);
    expect(decide(bySpelling, read(join(p, "docs", "link.txt"), "read", p))).toContain("deny:");
    expect(decide(bySpelling, read(join(p, "docs", "real.txt"), "read", p))).toBeUndefined();
  });

  // spec: AC-PERM-16
  test("a rule path is canonicalized too: Read(/etc/**) applies to /private/etc/hosts where /etc is a link", () => {
    const mac = (p: string) => (p === "/etc" ? "/private/etc" : p);
    const r = load({ deny: ["Read(//etc/**)"] }, { os: "darwin", canonicalize: mac });
    expect(decide(r, read("/private/etc/hosts"))).toBe("deny:Read(//etc/**)");
    expect(decide(r, read("/etc/hosts"))).toBe("deny:Read(//etc/**)");
  });
});

describe("matching", () => {
  // spec: AC-PERM-16
  test("extra spaces, tabs and a quoted # or - do not defeat a rule", () => {
    const r = load({ allow: ["Bash(git commit *)"] });
    expect(decide(r, bash('git  commit\t-m "a # b"'))).toBe("allow:Bash(git commit *)");
    expect(decide(r, bash("git commit -m '- x'"))).toBe("allow:Bash(git commit *)");
  });

  // spec: AC-PERM-16
  test("a deny catches the command behind sudo, env and leading assignments; an allow strips only the safe wrappers", () => {
    const r = load({ deny: ["Bash(rm *)"], allow: ["Bash(npm test *)", "Bash(grep *)"] });
    for (const c of [
      "sudo rm x",
      "env A=1 rm x",
      "A=1 rm x",
      "sudo -u root rm x",
      "nice -n 5 timeout 10 rm x",
      "xargs -n1 rm",
    ]) {
      expect(decide(r, bash(c))).toBe("deny:Bash(rm *)");
    }
    expect(decide(r, bash("timeout 30 npm test"))).toBe("allow:Bash(npm test *)");
    expect(decide(r, bash("NODE_ENV=test npm test"))).toBe("allow:Bash(npm test *)");
    expect(decide(r, bash("FOO=bar npm test"))).toBeUndefined();
    expect(decide(r, bash("sudo npm test"))).toBeUndefined();
    expect(decide(r, bash("xargs -n1 grep"))).toBeUndefined();
    expect(decide(r, bash("xargs grep x"))).toBe("allow:Bash(grep *)");
  });

  // spec: AC-PERM-16
  test("a redirect is not part of the matched text, and its target is still checked against the path rules", () => {
    const r = load({ allow: ["Bash(python *)"], deny: ["Edit(/out.txt)"] });
    expect(decide(r, bash("python x.py"))).toBe("allow:Bash(python *)");
    const call = bash("python x.py > out.txt");
    const noRedirectRule = load({ allow: ["Bash(python *)"] });
    expect(decide(noRedirectRule, call)).toBe("allow:Bash(python *)");
    expect(decide(r, call)).toBe("deny:Edit(/out.txt)");
    expect(decide(r, bash("python x.py > /dev/null 2>&1"))).toBe("allow:Bash(python *)");
  });

  // spec: AC-PERM-16
  test("WebFetch domains: exact, subdomain, *, one label, case and trailing dot", () => {
    const host = (rule: string, h: string) => decide(load({ deny: [rule] }), { tool: "WebFetch", cwd: "/p", host: h });
    expect(host("WebFetch(domain:example.com)", "Example.COM.")).toContain("deny:");
    expect(host("WebFetch(domain:example.com)", "a.example.com")).toBeUndefined();
    expect(host("WebFetch(domain:*.example.com)", "a.b.example.com")).toContain("deny:");
    expect(host("WebFetch(domain:*.example.com)", "example.com")).toBeUndefined();
    expect(host("WebFetch(domain:*)", "anything.test")).toContain("deny:");
    expect(host("WebFetch(domain:example.*)", "example.org")).toContain("deny:");
    expect(host("WebFetch(domain:example.*)", "example.evil.com")).toBeUndefined();
    const allow = load({ allow: ["WebFetch(domain:docs.example.com)"] });
    expect(decide(allow, { tool: "WebFetch", cwd: "/p", host: "docs.example.com" })).toContain("allow:");
    expect(decide(allow, { tool: "WebFetch", cwd: "/p", host: "other.com" })).toBeUndefined();
  });
});

describe("robust loading", () => {
  // spec: AC-PERM-15
  test("text after the closing parenthesis is an error naming file and line", () => {
    const file =
      '{\n  "permissions": {\n    "allow": [\n      "Bash(git status)",\n      "Bash(ls) x"\n    ]\n  }\n}\n';
    const r = loadRules([{ file: "/p/.dovet/settings.json", baseDir: "/p", ...ruleTexts(file) }], ctx());
    const err = r.issues.filter((i) => i.severity === "error");
    expect(err).toEqual([expect.objectContaining({ file: "/p/.dovet/settings.json", line: 5 })]);
    expect(err[0]?.message).toContain("Bash(ls) x");
    expect(decide(r, bash("git status"))).toBe("allow:Bash(git status)");
    expect(decide(r, bash("ls"))).toBeUndefined();
  });

  // spec: AC-PERM-15
  test("a rule with a NUL byte matches nothing", () => {
    const r = load({ deny: ["Bash(rm *\0)", "Read(a\0b)"], allow: ["Bash(ls\0)"] });
    expect(decide(r, bash("rm x"))).toBeUndefined();
    expect(decide(r, bash("ls"))).toBeUndefined();
    expect(decide(r, read("/p/a\0b"))).toBeUndefined();
  });

  // spec: AC-PERM-15
  test("a deny pattern that can't compile guards the literal path; in an allow rule it is ignored with a warning", () => {
    const r = load({ deny: ["Read(secrets[)"], allow: ["Read(open[)", "Read(/fine/**)"] });
    expect(decide(r, read("/p/secrets["))).toBe("deny:Read(secrets[)");
    expect(decide(r, read("/p/secrets"))).toBeUndefined();
    expect(decide(r, read("/p/s"))).toBeUndefined();
    expect(decide(r, read("/p/open["))).toBeUndefined();
    expect(decide(r, read("/p/fine/a"))).toBe("allow:Read(/fine/**)");
    expect(r.issues.filter((i) => i.severity === "warning" && i.message.includes("Read(open[)")).length).toBe(1);
  });

  // spec: AC-PERM-15
  test("rules named like Object.prototype members are ordinary rules", () => {
    const r = load({ deny: ["toString", "__proto__", "constructor(x)", "Bash(rm *)"] });
    expect(decide(r, { tool: "toString", cwd: "/p" })).toBe("deny:toString");
    expect(decide(r, { tool: "__proto__", cwd: "/p" })).toBe("deny:__proto__");
    expect(decide(r, bash("rm x"))).toBe("deny:Bash(rm *)");
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  // spec: AC-PERM-15
  test("unknown tool names in deny or ask warn; an allow shadowed by a deny is reported with both sources", () => {
    const sources: RuleSource[] = [
      {
        file: "/home/u/.config/dovet/settings.json",
        baseDir: "/x",
        deny: [
          { text: "Bash(aws *)", line: 4 },
          { text: "Bsh(x)", line: 5 },
        ],
      },
      {
        file: "/p/.dovet/settings.json",
        baseDir: "/p",
        allow: [
          { text: "Bash(aws s3 ls)", line: 9 },
          { text: "Bash(git push)", line: 10 },
        ],
        ask: [{ text: "WebFetch", line: 11 }],
      },
      { file: "/p/.dovet/settings.local.json", baseDir: "/p", deny: [{ text: "WebFetch" }] },
    ];
    const r = loadRules(sources, ctx({ knownTools: new Set(["Bash", "WebFetch", "Read", "Edit"]) }));
    const msgs = r.issues.map((i) => i.message);
    expect(msgs.some((m) => m.includes("Bsh"))).toBe(true);
    const shadow = r.issues.find((i) => i.message.includes("Bash(aws s3 ls)"));
    expect(shadow?.file).toBe("/p/.dovet/settings.json");
    expect(shadow?.line).toBe(9);
    expect(shadow?.message).toContain("Bash(aws *)");
    expect(shadow?.message).toContain("/home/u/.config/dovet/settings.json:4");
    expect(r.issues.some((i) => i.message.includes("Bash(git push)"))).toBe(false);
    expect(r.issues.find((i) => i.message.includes("ask rule WebFetch"))?.message).toContain("settings.local.json");
  });
});

describe("rule examples", () => {
  // spec: AC-PERM-15
  test("a mismatch names the rule that decides; a match is silent", () => {
    const r = load({ deny: ["Bash(git push *)"], allow: ["Bash(git status)"] });
    const issues = checkExamples(r.rules, [
      { Bash: "git push --force origin main", expect: "deny" },
      { Bash: "git status && git push origin main", expect: "allow" },
      { Bash: "git status", expect: "allow" },
      { Read: "/p/a.txt", expect: "ask" },
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]?.message).toContain("git status && git push origin main");
    expect(issues[0]?.message).toContain("Bash(git push *)");
    expect(issues[0]?.message).toContain("expected allow");
  });
});
