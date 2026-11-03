import { rm } from "node:fs/promises";

const WINDOWS_HOLDING = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

type Options = { remove?: (dir: string) => Promise<void>; attempts?: number; delayMs?: number };

/** Windows keeps a just-run executable (or a file a scanner is reading) open for a moment; Bun's `rmSync` `maxRetries`
 * did not retry an EBUSY in CI (F88: the failure came 11 ms after it started, with 5 retries of 200 ms configured). */
export async function removeDir(
  dir: string,
  { remove = (d) => rm(d, { recursive: true, force: true }), attempts = 20, delayMs = 500 }: Options = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await remove(dir);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= attempts || code === undefined || !WINDOWS_HOLDING.has(code)) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
