import { readFile, stat } from "node:fs/promises";
import { isErrno } from "../../platform/index.ts";
import { SettingsError } from "./errors.ts";

const MAX_BYTES = 2 * 1024 * 1024;

function refuse(file: string, message: string): SettingsError {
  return new SettingsError([{ file, key: "", message }]);
}

/** The text of a settings file, or undefined when there is none. Only regular files up to 2 MiB are read (a FIFO would block). */
export async function readSettingsText(file: string): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch (err) {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return undefined;
    throw refuse(file, `can't be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!info.isFile()) {
    const kind = info.isDirectory() ? "a directory" : info.isFIFO() ? "a FIFO" : "a device or socket";
    throw refuse(file, `is not a regular file (it is ${kind}); settings files must be regular files`);
  }
  if (info.size > MAX_BYTES) {
    throw refuse(file, `is ${(info.size / (1024 * 1024)).toFixed(1)} MiB, over the 2 MiB limit for settings files`);
  }
  const text = await readFile(file, "utf8");
  if (text.length > MAX_BYTES)
    throw refuse(file, "grew past the 2 MiB limit for settings files while it was being read");
  return text;
}
