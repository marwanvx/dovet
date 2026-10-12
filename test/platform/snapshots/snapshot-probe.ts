// Built by snapshots.test.ts with Dovet's own compile options (scripts/build.ts). Takes a snapshot of the repository in
// argv[2], edits, deletes and adds files, takes a second snapshot, restores the first, and prints what it saw as JSON.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSnapshotter } from "../../../src/store/snapshots/index.ts";

const [workspace, projectDir] = process.argv.slice(2);
if (workspace === undefined || projectDir === undefined) throw new Error("usage: probe <workspace> <projectDir>");

const snapshotter = await openSnapshotter({
  workspace,
  projectDir,
  session: "probe",
  env: process.env,
  platform: process.platform,
});
const read = (name: string): string | null =>
  existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), "utf8") : null;

const before = await snapshotter.snapshot();
writeFileSync(join(workspace, "a.txt"), "edited by the agent\n");
writeFileSync(join(workspace, "b.dat"), "edited too\n");
rmSync(join(workspace, "src", "keep.txt"));
mkdirSync(join(workspace, "made"), { recursive: true });
writeFileSync(join(workspace, "made", "new.txt"), "brand new\n");
const after = await snapshotter.snapshot();
const edited = { a: read("a.txt"), keep: read("src/keep.txt"), created: read("made/new.txt") };
const restored = await snapshotter.restore(before.tree, before.skipped);

process.stdout.write(
  `${JSON.stringify({
    trees: [before.tree, after.tree],
    edited,
    restored: {
      result: restored,
      a: read("a.txt"),
      b: read("b.dat"),
      keep: read("src/keep.txt"),
      created: read("made/new.txt"),
      madeDirExists: existsSync(join(workspace, "made")),
    },
  })}\n`,
);
