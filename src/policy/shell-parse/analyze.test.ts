import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempProject } from "../../../test/helpers/index.ts";
import { evaluateRules, loadRules, type RuleCall, type RuleSet, type Subcommand } from "../rules/index.ts";
import { type Analysis, analyzeShell, powershellExitOneIsBenign } from "./analyze.ts";
import { expandGlob } from "./glob.ts";
import { loadShellParsers, type ShellLanguage, type ShellParsers } from "./load.ts";

let parsers: ShellParsers;
let root = "";
let dispose: () => Promise<void>;

beforeAll(async () => {
  parsers = await loadShellParsers();
  const files: Record<string, string> = {
    "a.ts": "a",
    "b.ts": "b",
    ".env": "KEY=1",
    "src/x.ts": "x",
    "README.md": "r",
  };
  const project = await tempProject(files);
  root = project.root;
  dispose = project.dispose;
});
afterAll(() => dispose());

const analyze = (command: string, language: ShellLanguage = "bash", over: { cwd?: string; budgetMs?: number } = {}) =>
  analyzeShell(parsers, language, command, {
    cwd: over.cwd ?? root,
    workingDirs: [root],
    home: join(root, "..", "home"),
    glob: expandGlob,
    ...(over.budgetMs === undefined ? {} : { budgetMs: over.budgetMs }),
  });

function rulesFor(lists: { allow?: string[]; ask?: string[]; deny?: string[] }): RuleSet {
  const texts = (xs: string[] = []) => xs.map((text) => ({ text }));
  return loadRules(
    [
      {
        file: "/p/.dovet/settings.json",
        baseDir: root,
        allow: texts(lists.allow),
        ask: texts(lists.ask),
        deny: texts(lists.deny),
      },
    ],
    { os: "linux", home: "/home/u", canonicalize: (p) => p },
  ).rules;
}

function call(a: Analysis, tool = "Bash"): RuleCall {
  return {
    tool,
    cwd: root,
    ...(a.commands === undefined ? {} : { commands: a.commands }),
    checkable: a.understood,
    paths: a.operands,
  };
}

const decide = (command: string, lists: Parameters<typeof rulesFor>[0], language: ShellLanguage = "bash") => {
  const m = evaluateRules(
    rulesFor(lists),
    call(analyze(command, language), language === "bash" ? "Bash" : "PowerShell"),
  );
  return m === undefined ? undefined : `${m.behavior}:${m.rule}`;
};

const allReadOnly = (a: Analysis): boolean =>
  a.understood &&
  a.commands !== undefined &&
  a.commands.length > 0 &&
  a.commands.every((c: Subcommand) => c.readOnly === true);

describe("compound commands and wrappers", () => {
  // spec: AC-PERM-02
  test("every subcommand must match an allow rule on its own", () => {
    expect(decide("echo ok && rm -rf build", { allow: ["Bash(echo *)"] })).toBeUndefined();
    expect(decide("echo ok && echo fine", { allow: ["Bash(echo *)"] })).toBe("allow:Bash(echo *)");
    expect(decide("echo a | tee x; echo b", { allow: ["Bash(echo *)"] })).toBeUndefined();
  });

  // spec: AC-PERM-02
  test("an ask rule matches any subcommand, inside substitutions and loops too", () => {
    expect(decide("cd /tmp && git clean -f", { ask: ["Bash(git clean *)"] })).toBe("ask:Bash(git clean *)");
    expect(decide('echo "$(git clean -f)"', { ask: ["Bash(git clean *)"] })).toBe("ask:Bash(git clean *)");
    expect(decide("for f in a b; do git clean -f; done", { ask: ["Bash(git clean *)"] })).toBe("ask:Bash(git clean *)");
    expect(decide("( git clean -f )", { ask: ["Bash(git clean *)"] })).toBe("ask:Bash(git clean *)");
  });

  // spec: AC-PERM-02
  test("a dangling && is not understood, so no allow rule applies", () => {
    const a = analyze("echo ok &&");
    expect(a.understood).toBe(false);
    expect(decide("echo ok &&", { allow: ["Bash(echo *)"] })).toBeUndefined();
  });

  // spec: AC-PERM-03
  test("wrappers and leading assignments are stripped when matching", () => {
    expect(decide("timeout 30 npm test", { allow: ["Bash(npm test *)"] })).toBe("allow:Bash(npm test *)");
    expect(decide("FOO=bar rm -rf x", { deny: ["Bash(rm *)"] })).toBe("deny:Bash(rm *)");
    expect(decide("sudo env X=1 rm -rf x", { deny: ["Bash(rm *)"] })).toBe("deny:Bash(rm *)");
    expect(decide("xargs -n1 grep", { allow: ["Bash(grep *)"] })).toBeUndefined();
  });

  // spec: AC-PERM-04
  test("exec wrappers, find actions and daemon or force flags are never approved by a prefix rule", () => {
    expect(decide("watch ls", { allow: ["Bash(watch *)"] })).toBeUndefined();
    expect(decide("watch ls", { allow: ["Bash(watch ls)"] })).toBe("allow:Bash(watch ls)");
    expect(decide("find . -delete", { allow: ["Bash(find *)"] })).toBeUndefined();
    expect(decide("find . -exec rm {} ;", { allow: ["Bash(find *)"] })).toBeUndefined();
    expect(decide("find . -name a", { allow: ["Bash(find *)"] })).toBe("allow:Bash(find *)");
    expect(decide("docker -H tcp://x ps", { allow: ["Bash(docker *)"] })).toBeUndefined();
    expect(decide("git push --force origin main", { allow: ["Bash(git push *)"] })).toBeUndefined();
    expect(decide("git push --force origin main", { allow: ["Bash(git push --force origin main)"] })).toContain(
      "allow:",
    );
    expect(decide("git push origin main", { allow: ["Bash(git push *)"] })).toBe("allow:Bash(git push *)");
  });
});

describe("redirects and tee", () => {
  // spec: AC-PERM-08
  test("output redirect targets are paths checked like an Edit, relative to the simulated cwd", () => {
    const a = analyze("cd src && python x.py > out.txt");
    expect(a.commands?.[1]?.redirects).toEqual([{ op: ">", target: join(root, "src", "out.txt") }]);
    expect(decide("python x.py > out.txt", { allow: ["Bash(python *)"], deny: ["Edit(out.txt)"] })).toBe(
      "deny:Edit(out.txt)",
    );
    expect(decide("python x.py < in.txt > out.txt", { allow: ["Bash(python *)"] })).toBe("allow:Bash(python *)");
  });

  // spec: AC-PERM-08
  test("tee targets are edit operands; ~ or a glob needs approval", () => {
    const a = analyze("echo hi | tee notes.txt");
    expect(a.operands).toEqual([{ access: "edit", path: join(root, "notes.txt") }]);
    expect(
      decide("echo hi | tee notes.txt", { allow: ["Bash(echo *)", "Bash(tee *)"], deny: ["Edit(notes.txt)"] }),
    ).toBe("deny:Edit(notes.txt)");
    expect(analyze("echo hi | tee ~/.bashrc").understood).toBe(false);
    expect(analyze("echo hi | tee *.log").understood).toBe(false);
  });

  // spec: AC-PERM-08
  test("/dev/null, fd forms and here-docs are not checked", () => {
    const a = analyze("ls > /dev/null 2>&1; cat <<EOF\nhi\nEOF\ncat <<< word");
    expect(a.understood).toBe(true);
    expect(a.commands?.flatMap((c) => c.redirects ?? [])).toEqual([]);
    expect(a.operands).toEqual([]);
  });

  // spec: AC-PERM-08
  test("an input redirect from outside the working directories is not read-only", () => {
    expect(allReadOnly(analyze("cat < a.ts"))).toBe(true);
    expect(allReadOnly(analyze("cat < ../elsewhere"))).toBe(false);
    expect(allReadOnly(analyze("ls > out.txt"))).toBe(false);
  });
});

describe("file operands, globs and the simulated cwd", () => {
  // spec: AC-PERM-21
  test("an unquoted glob in a file position expands to the files it matches", () => {
    const a = analyze("ls *.ts");
    expect(allReadOnly(a)).toBe(true);
    expect(a.operands.map((o) => o.path).sort()).toEqual([join(root, "a.ts"), join(root, "b.ts")]);
  });

  // spec: AC-PERM-20
  test("an unquoted glob in a pattern position, or a glob with find, asks", () => {
    expect(allReadOnly(analyze("rg foo*"))).toBe(false);
    expect(allReadOnly(analyze("find . -name *.ts"))).toBe(false);
    expect(allReadOnly(analyze('rg "foo*" src'))).toBe(true);
  });

  // spec: AC-PERM-20
  test("more than 1,000 glob matches asks", async () => {
    const many = await tempProject(Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}.log`, ""])));
    try {
      const a = analyzeShell(parsers, "bash", "ls *.log", {
        cwd: many.root,
        workingDirs: [many.root],
        glob: expandGlob,
      });
      expect(a.commands?.[0]?.readOnly).toBe(false);
      expect(a.reasons.join()).toContain("more than 1000");
    } finally {
      await many.dispose();
    }
  });

  // spec: AC-PERM-20
  test("cd, pushd and popd move the cwd the operands are resolved in", () => {
    expect(analyze("cd src && cat x.ts").operands).toEqual([{ access: "read", path: join(root, "src", "x.ts") }]);
    expect(analyze("pushd src; cat x.ts; popd; cat a.ts").operands.map((o) => o.path)).toEqual([
      join(root, "src", "x.ts"),
      join(root, "a.ts"),
    ]);
    expect(allReadOnly(analyze("cd .. && cat secret"))).toBe(false);
    expect(allReadOnly(analyze("cd /etc && cat passwd"))).toBe(false);
    expect(allReadOnly(analyze("cd $HOME && ls"))).toBe(false);
  });

  // spec: AC-PERM-20
  test("git after a cd into another directory is not read-only, but a cd into the project is", () => {
    expect(allReadOnly(analyze(`cd ${join(root, "src")} && git status`))).toBe(false);
    expect(allReadOnly(analyze(`cd ${root} && git status`))).toBe(true);
  });

  // spec: AC-PERM-20
  test("a for loop over a glob checks the files the variable takes", () => {
    const a = analyze('for f in *.ts; do wc -l "$f"; done');
    expect(allReadOnly(a)).toBe(true);
    expect(a.operands.map((o) => o.path).sort()).toEqual([join(root, "a.ts"), join(root, "b.ts")]);
    expect(allReadOnly(analyze("for f in $(ls); do wc -l $f; done"))).toBe(false);
  });

  // spec: AC-PERM-22
  test("an option the data file doesn't list makes a read-only command not read-only", () => {
    expect(allReadOnly(analyze("ls -la src"))).toBe(true);
    expect(allReadOnly(analyze("ls --frobnicate"))).toBe(false);
    expect(allReadOnly(analyze("cat -Z a.ts"))).toBe(false);
    expect(allReadOnly(analyze("git diff --output=x.patch"))).toBe(false);
    expect(allReadOnly(analyze("git branch newname"))).toBe(false);
    expect(allReadOnly(analyze("git branch --list"))).toBe(true);
    expect(allReadOnly(analyze("find . -fprint x"))).toBe(false);
    expect(allReadOnly(analyze("date -s tomorrow"))).toBe(false);
    expect(allReadOnly(analyze("awk 'BEGIN{system(\"id\")}' a.ts"))).toBe(false);
  });
});

describe("fail-closed analysis", () => {
  // spec: AC-PERM-22
  test("a parse that outlasts the budget is cancelled and gives no commands", () => {
    const text = "echo a; ".repeat(1200);
    const t0 = performance.now();
    const full = parsers.withTree("bash", text, 10_000, (n) => n.hasError);
    const fullMs = performance.now() - t0;
    expect(full).toBe(false);
    const t1 = performance.now();
    const cut = parsers.withTree("bash", text, 1, (n) => n.hasError);
    const cutMs = performance.now() - t1;
    expect(cut).toBeUndefined();
    expect(cutMs).toBeLessThan(fullMs / 2);
    const a = analyze(text, "bash", { budgetMs: 1 });
    expect(a).toMatchObject({ commands: undefined, understood: false });
    expect(decide(text, { allow: ["Bash(echo *)"] })).toBe("allow:Bash(echo *)");
    expect(evaluateRules(rulesFor({ allow: ["Bash(echo *)"] }), call(a))).toBeUndefined();
  });

  // spec: AC-PERM-22
  test("the parser works again after a cancelled parse", () => {
    analyze("echo a; ".repeat(1200), "bash", { budgetMs: 1 });
    expect(analyze("ls src").commands?.[0]?.argv).toEqual(["ls", "src"]);
  });

  // spec: AC-PERM-22
  test("a parser that throws is not understood and has no commands", () => {
    const broken = {
      ...parsers,
      withTree: () => {
        throw new Error("out of memory");
      },
    } as unknown as ShellParsers;
    const a = analyzeShell(broken, "bash", "ls", { cwd: root, workingDirs: [root], glob: expandGlob });
    expect(a).toMatchObject({ commands: undefined, understood: false });
    expect(a.reasons.join()).toContain("out of memory");
  });

  // spec: AC-PERM-22
  test("a 10,001-character command is never understood, in Bash and PowerShell", () => {
    const ok = `echo ${"a".repeat(10_000 - 5)}`;
    expect(analyze(ok).understood).toBe(true);
    for (const language of ["bash", "powershell"] as const) {
      const long = `${language === "bash" ? "echo" : "Write-Output"} ${"a".repeat(10_001 - (language === "bash" ? 5 : 13))}`;
      expect(long).toHaveLength(10_001);
      const a = analyze(long, language);
      expect(a.understood).toBe(false);
      expect(a.reasons.join()).toContain("10000");
    }
  });
});

describe("PowerShell", () => {
  test("aliases are canonicalized and matching ignores case", () => {
    expect(analyze("gci -Path src -Recurse", "powershell").commands?.[0]?.argv[0]).toBe("Get-ChildItem");
    expect(decide("rm -Recurse build", { deny: ["PowerShell(remove-item *)"] }, "powershell")).toBe(
      "deny:PowerShell(remove-item *)",
    );
  });

  test("the pipeline, ; and && are split and read-only cmdlets are recognized", () => {
    const a = analyze("Get-ChildItem -Path src -Recurse | Select-String Dovet; Get-Content README.md", "powershell");
    expect(a.commands).toHaveLength(3);
    expect(allReadOnly(a)).toBe(true);
    expect(a.operands.map((o) => o.path)).toEqual([join(root, "src"), join(root, "README.md")]);
    expect(allReadOnly(analyze("Get-Item x -OutVariable y", "powershell"))).toBe(false);
    expect(analyze("$x = 1", "powershell").understood).toBe(false);
  });

  // spec: AC-PERM-20
  test("cd moves the simulated cwd", () => {
    expect(allReadOnly(analyze("cd ..; gc ..\\secret", "powershell"))).toBe(false);
    expect(allReadOnly(analyze("cd src; gc x.ts", "powershell"))).toBe(true);
  });

  test("benign exit 1 follows the last command", () => {
    expect(powershellExitOneIsBenign(analyze("Get-Content a.ts | Select-String zzz", "powershell").commands)).toBe(
      true,
    );
    expect(powershellExitOneIsBenign(analyze("findstr x a.ts", "powershell").commands)).toBe(true);
    expect(powershellExitOneIsBenign(analyze("Remove-Item x", "powershell").commands)).toBe(false);
  });
});

type Entry = {
  language: ShellLanguage;
  command: string;
  source: string;
  allow?: string[];
  deny?: string[];
  expect?: string;
};
const corpus = async (name: string): Promise<Entry[]> =>
  (await Bun.file(join(import.meta.dir, "..", "testdata", name)).text())
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Entry);

describe("bypass corpus", () => {
  // spec: AC-PERM-20
  test("every entry names its source and none is auto-approved", async () => {
    const entries = await corpus("bypass-corpus.jsonl");
    expect(entries.length).toBeGreaterThan(30);
    const approved: string[] = [];
    for (const e of entries) {
      expect(e.source).not.toBe("");
      const a = analyze(e.command, e.language);
      const tool = e.language === "bash" ? "Bash" : "PowerShell";
      const match = evaluateRules(rulesFor({ allow: e.allow ?? [], deny: e.deny ?? [] }), call(a, tool));
      const byRule = match?.behavior === "allow";
      const byReadOnly = allReadOnly(a) && match?.behavior !== "deny";
      if (byRule || byReadOnly) approved.push(e.command);
    }
    expect(approved).toEqual([]);
  });
});

describe("false-prompt corpus", () => {
  // spec: AC-PERM-21
  test("none of these prompts in default mode inside the project", async () => {
    const entries = await corpus("false-prompt-corpus.jsonl");
    const failed: string[] = [];
    for (const e of entries) {
      const a = analyze(e.command.replaceAll("{root}", root), e.language);
      const rules = rulesFor({ allow: e.allow ?? [] });
      const ok =
        e.expect === "read-only"
          ? allReadOnly(a)
          : e.expect === "allowed"
            ? evaluateRules(rules, call(a))?.behavior === "allow"
            : e.expect === "sandbox"
              ? a.understood && a.literalNames
              : a.understood;
      if (!ok) failed.push(`${e.command} → ${a.reasons.join("; ")}`);
    }
    expect(failed).toEqual([]);
  });
});
