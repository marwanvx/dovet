// Turns a snapshot store's pack into loose objects so a test can delete exactly one of them.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function unpackToLoose(projectDir: string, env: Record<string, string | undefined>): void {
  const objects = join(projectDir, "objects");
  const packDir = join(objects, "pack");
  if (!existsSync(packDir)) return;
  for (const name of readdirSync(packDir).filter((n) => n.endsWith(".pack"))) {
    const bytes = readFileSync(join(packDir, name));
    for (const ext of [".pack", ".idx", ".rev"]) rmSync(join(packDir, name.replace(/\.pack$/, ext)), { force: true });
    const r = Bun.spawnSync(["git", "unpack-objects", "-q"], {
      cwd: projectDir,
      env: { ...env, GIT_DIR: join(projectDir, "git"), GIT_OBJECT_DIRECTORY: objects },
      stdin: bytes,
    });
    if (r.exitCode !== 0) throw new Error(`git unpack-objects failed: ${r.stderr.toString()}`);
  }
}

/** Deletes the loose object `id` (a blob that `unpackToLoose` made). */
export function deleteObject(projectDir: string, id: string): void {
  rmSync(join(projectDir, "objects", id.slice(0, 2), id.slice(2)));
}
