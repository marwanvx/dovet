import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AbsPath } from "../../src/schema/index.ts";

export type TempProject = { root: AbsPath; dispose(): Promise<void> };

/** A temp directory with the given files (relative path → text). `root` is symlink-resolved (macOS /var, Windows short names). */
export async function tempProject(files: Record<string, string> = {}): Promise<TempProject> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dovet-test-")));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}
