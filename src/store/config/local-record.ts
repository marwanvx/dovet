import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isErrno, type Os, pathKey } from "../../platform/index.ts";
import { writeFileAtomic } from "./atomic.ts";

/** Where Dovet remembers the local settings file it wrote, so a file it didn't write isn't taken for the user's own (permissions §11). */
export type LocalRecordSite = { dataDir: string; os: Os };

const FILE = "local-settings.json";
const Records = z.record(z.string(), z.object({ hash: z.string() }));

export const hashLocalText = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A missing, unreadable or damaged record means no file is known to be Dovet's own: trust is never granted by a failure. */
async function readRecords(dataDir: string): Promise<z.infer<typeof Records>> {
  const text = await readFile(join(dataDir, FILE), "utf8").catch((err: unknown) => {
    if (isErrno(err, "ENOENT", "ENOTDIR")) return undefined;
    throw err;
  });
  if (text === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = Records.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export async function recordLocalFile(site: LocalRecordSite, projectRoot: string, text: string): Promise<void> {
  const records = await readRecords(site.dataDir);
  const next = { ...records, [pathKey(projectRoot, site.os)]: { hash: hashLocalText(text) } };
  await mkdir(site.dataDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(site.dataDir, FILE), `${JSON.stringify(next, null, 2)}\n`);
}

/** Whether `text` is exactly what Dovet last wrote to this project's local settings file. */
export async function localFileRecorded(site: LocalRecordSite, projectRoot: string, text: string): Promise<boolean> {
  const entry = (await readRecords(site.dataDir))[pathKey(projectRoot, site.os)];
  return entry !== undefined && entry.hash === hashLocalText(text);
}
