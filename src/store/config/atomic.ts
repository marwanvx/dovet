import { readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isErrno } from "../../platform/index.ts";

/** Temp file plus rename; a symlinked file is replaced at its target and the link is kept. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  let target = path;
  try {
    target = await realpath(path);
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
    target = await readlink(path).then(
      (link) => resolve(dirname(path), link),
      (e: unknown) => (isErrno(e, "ENOENT", "EINVAL") ? path : Promise.reject(e)),
    );
  }
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    (err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)),
  );
  const temp = join(dirname(target), `.${basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, data, mode === undefined ? undefined : { mode });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
