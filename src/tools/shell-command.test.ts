import { describe, expect, test } from "bun:test";
import {
  exitOneIsBenign,
  fileView,
  INTERACTIVE_NOTICE,
  interactiveNotice,
  rewriteNulRedirects,
  rewritesWorktree,
} from "./shell-command.ts";
import { simpleCommands } from "./shell-words.ts";

describe("shell command shapes", () => {
  // spec: AC-TOOLS-08
  test("commands that need a terminal are flagged, their non-interactive forms are not", () => {
    for (const c of [
      "git commit",
      "git commit -a",
      "git -C sub commit",
      "git rebase -i HEAD~3",
      "git add -p",
      "vim a.txt",
      "nano a.txt && echo done",
      "ssh host",
      "ssh -p 22 host",
      "top",
      "less a.log",
      "FOO=1 git commit",
    ]) {
      expect(interactiveNotice(c), c).toBe(INTERACTIVE_NOTICE);
    }
    for (const c of [
      'git commit -m "x"',
      "git commit -am x",
      "git commit --amend --no-edit",
      "git commit -F msg.txt",
      "git rebase main",
      "ssh host ls",
      "ssh -N host",
      "echo vim",
      "cat a | less",
      "top -b -n 1",
      "echo 'git commit'",
      "grep vim a.txt",
    ]) {
      expect(interactiveNotice(c), c).toBeUndefined();
    }
  });

  // spec: AC-TOOLS-07
  test("exit 1 is benign for the last command when it is grep, rg, find, diff, test, [ or git diff/grep", () => {
    for (const c of [
      "grep x f",
      "rg x",
      "egrep x f",
      "fgrep x f",
      "find . -name x",
      "diff a b",
      "test -f x",
      "[ -f x ]",
    ]) {
      expect(exitOneIsBenign(c), c).toBe(true);
    }
    expect(exitOneIsBenign("git diff --quiet")).toBe(true);
    expect(exitOneIsBenign("git -C x grep foo")).toBe(true);
    expect(exitOneIsBenign("cd src && grep x f")).toBe(true);
    expect(exitOneIsBenign("cat f | grep x")).toBe(true);
    for (const c of ["false", "git status", "git log", "grep x f; false", "npm test", "ls | wc"]) {
      expect(exitOneIsBenign(c), c).toBe(false);
    }
  });

  // spec: AC-TOOLS-41
  test("recognized file views: one file, no pipes or redirects; only plain cat is whole", () => {
    expect(fileView("cat a.ts")).toEqual({ file: "a.ts", whole: true });
    expect(fileView("cat -n a.ts")).toEqual({ file: "a.ts", whole: false });
    expect(fileView("head -n 20 src/a.ts")).toEqual({ file: "src/a.ts", whole: false });
    expect(fileView("tail -5 a.ts")).toEqual({ file: "a.ts", whole: false });
    expect(fileView("nl a.ts")).toEqual({ file: "a.ts", whole: false });
    expect(fileView("sed -n '10,20p' a.ts")).toEqual({ file: "a.ts", whole: false });
    expect(fileView("grep -n foo a.ts")).toEqual({ file: "a.ts", whole: false });
    expect(fileView('rg "foo bar" a.ts')).toEqual({ file: "a.ts", whole: false });
    for (const c of [
      "cat a.ts b.ts",
      "cat a.ts | head",
      "cat a.ts > b.ts",
      "cat *.ts",
      "cat $F",
      "grep -r foo a",
      "grep -e foo a.ts",
      "grep foo",
      "sed -i s/a/b/ a.ts",
      "sed -n '1p' a.ts && rm a.ts",
      "ls a.ts",
      "head -n x a.ts",
    ]) {
      expect(fileView(c), c).toBeUndefined();
    }
  });

  test("git merge, pull, checkout and switch rewrite the worktree", () => {
    expect(rewritesWorktree("git pull --rebase")).toBe(true);
    expect(rewritesWorktree("cd x && git checkout main")).toBe(true);
    expect(rewritesWorktree("git status")).toBe(false);
  });

  test("the reader gives up on what it cannot read exactly", () => {
    expect(simpleCommands("echo 'unterminated")).toBeUndefined();
    expect(simpleCommands("echo $(date)")).toBeUndefined();
    expect(simpleCommands("cat <<EOF\nx\nEOF")).toBeUndefined();
    expect(simpleCommands("a && b | c; d &")?.map((s) => s.words)).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(simpleCommands("echo hi # note")?.[0]?.words).toEqual(["echo", "hi"]);
  });
});

describe("Git Bash nul redirects", () => {
  // spec: AC-PLAT-06
  test("unquoted CMD-style nul targets become /dev/null; quoted, longer and file names are left alone", () => {
    const rewrite = (c: string) => rewriteNulRedirects(c);
    expect(rewrite("echo x 2>nul")).toEqual({ command: "echo x 2>/dev/null", changed: true });
    expect(rewrite("ls >NUL 2>&1; cat a &>nul")).toEqual({
      command: "ls >/dev/null 2>&1; cat a &>/dev/null",
      changed: true,
    });
    expect(rewrite("echo a2>nul")).toEqual({ command: "echo a2>/dev/null", changed: true });
    expect(rewrite("(echo y)>nul; dir>nul 2>&1").command).toBe("(echo y)>/dev/null; dir>/dev/null 2>&1");
    expect(rewrite("echo x >> nul | cat").command).toBe("echo x >> /dev/null | cat");
    for (const same of ['echo "2>nul"', "echo '2>nul'", "echo x > null", "echo x > nul.txt", "echo 2>nulx"]) {
      expect(rewrite(same)).toEqual({ command: same, changed: false });
    }
  });
});
