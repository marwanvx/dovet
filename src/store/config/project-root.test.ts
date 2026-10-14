import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempProject } from "../../../test/helpers/index.ts";
import { findProjectRoot } from "./project-root.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});
async function project(files: Record<string, string> = {}): Promise<string> {
  const p = await tempProject(files);
  dispose = p.dispose;
  return p.root;
}

describe("findProjectRoot", () => {
  // spec: AC-CLI-10
  test("a subdirectory of a repository belongs to the repository root", async () => {
    const root = await project({ ".git/HEAD": "ref: refs/heads/main\n", "pkg/a.ts": "" });
    expect(await findProjectRoot(join(root, "pkg"))).toBe(root);
  });

  // spec: AC-CLI-10
  test("a linked worktree resolves to the main checkout", async () => {
    const main = await project({ "repo/.git/HEAD": "x\n", "repo/.git/worktrees/w/commondir": "../..\n" });
    const repo = join(main, "repo");
    mkdirSync(join(main, "wt", "src"), { recursive: true });
    writeFileSync(join(main, "wt", ".git"), `gitdir: ${join(repo, ".git", "worktrees", "w")}\n`);
    expect(await findProjectRoot(join(main, "wt", "src"))).toBe(repo);
  });

  test("a submodule (a .git file without commondir) is its own project", async () => {
    const root = await project({ ".git/HEAD": "x\n", ".git/modules/s/HEAD": "x\n" });
    mkdirSync(join(root, "s", "lib"), { recursive: true });
    writeFileSync(join(root, "s", ".git"), "gitdir: ../.git/modules/s\n");
    expect(await findProjectRoot(join(root, "s", "lib"))).toBe(join(root, "s"));
  });

  test("outside a repository the starting directory is the root, symlinks resolved", async () => {
    const root = await project({ "d/x": "" });
    symlinkSync(join(root, "d"), join(root, "link"));
    expect(await findProjectRoot(join(root, "link"))).toBe(join(root, "d"));
  });
});
