import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isErrno } from "../../platform/index.ts";

const missing = (err: unknown): undefined => {
  if (isErrno(err, "ENOENT", "ENOTDIR")) return undefined;
  throw err;
};

/** The git repository containing `start`, resolved through linked worktrees to the main checkout; outside git, `start` itself (cli-config "Two directory concepts"). */
export async function findProjectRoot(start: string): Promise<string> {
  const origin = await realpath(start);
  for (let dir = origin; ; dir = dirname(dir)) {
    const info = await stat(join(dir, ".git")).catch(missing);
    if (info?.isDirectory()) return dir;
    if (info?.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(join(dir, ".git"), "utf8"));
      if (pointer?.[1] === undefined) return dir;
      const gitDir = resolve(dir, pointer[1].trim());
      const common = await readFile(join(gitDir, "commondir"), "utf8").catch(missing);
      return common === undefined ? dir : dirname(resolve(gitDir, common.trim()));
    }
    if (dirname(dir) === dir) return origin;
  }
}
