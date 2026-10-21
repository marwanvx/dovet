// Disk use and stored-session management (event-log "Disk use").
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isErrno } from "../../platform/index.ts";
import { writePrivateAtomic } from "../event-log/files.ts";
import { dirBytes, inventory, removeSession, type SessionFiles, sessionBytes } from "./layout.ts";

const DAY_MS = 86_400_000;
const GB = 1024 ** 3;
const LARGEST = 3;

export type StoredSession = SessionFiles & { bytes: number };

export function dataSize(data: string): Promise<number> {
  return dirBytes(data);
}

/** Every project's sessions with their disk use, oldest first. */
export async function listStored(data: string, now: number): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  for (const s of await inventory(data, now)) out.push({ ...s, bytes: await sessionBytes(s) });
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const Stamp = z.object({ day: z.string() });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** The startup warning when `<data>` is over `warnAtGB`: given at most once a day, naming the largest sessions. */
export async function sizeWarning(input: { data: string; warnAtGB: number; now: number }): Promise<string | undefined> {
  const size = await dataSize(input.data);
  if (size <= input.warnAtGB * GB) return undefined;
  const stamp = join(input.data, "size-warning.json");
  const day = new Date(input.now).toISOString().slice(0, 10);
  const text = await readFile(stamp, "utf8").catch((err: unknown) =>
    isErrno(err, "ENOENT") ? undefined : Promise.reject(err),
  );
  const last = text === undefined ? undefined : Stamp.safeParse(parseJson(text));
  if (last?.success === true && last.data.day === day) return undefined;
  const largest = (await listStored(input.data, input.now)).sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST);
  await writePrivateAtomic(stamp, `${JSON.stringify({ day })}\n`);
  const names = largest.map((s) => `${s.id} (${formatBytes(s.bytes)})`).join(", ");
  return `Dovet's data (${formatBytes(size)}) is over ${input.warnAtGB} GB. Largest sessions: ${names}. Free space with \`dovet sessions delete --older-than <days>\` or \`dovet gc\`.`;
}

/** "500", "10KB", "2mb", "1.5GB" → bytes; undefined for anything else. */
export function parseSize(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(text.trim());
  if (m?.[1] === undefined) return undefined;
  const unit = (m[2] ?? "b").toLowerCase();
  return Math.round(Number(m[1]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: GB }[unit as "b" | "kb" | "mb" | "gb"]);
}

export type DeletePick = { ids: string[] } | { olderThanDays: number } | { largerThanBytes: number };

/** Deletes the chosen sessions. Only ids that name a stored session match, so an id can't point anywhere else. */
export async function deleteStored(
  data: string,
  now: number,
  pick: DeletePick,
): Promise<{ deleted: StoredSession[]; skippedActive: StoredSession[]; missing: string[] }> {
  const all = await listStored(data, now);
  const chosen =
    "ids" in pick
      ? all.filter((s) => pick.ids.includes(s.id))
      : "olderThanDays" in pick
        ? all.filter((s) => now - s.modified > pick.olderThanDays * DAY_MS)
        : all.filter((s) => s.bytes > pick.largerThanBytes);
  const deleted: StoredSession[] = [];
  const skippedActive: StoredSession[] = [];
  for (const s of chosen) {
    if (s.active) skippedActive.push(s);
    else {
      await removeSession(s);
      deleted.push(s);
    }
  }
  const missing = "ids" in pick ? pick.ids.filter((id) => !all.some((s) => s.id === id)) : [];
  return { deleted, skippedActive, missing };
}
