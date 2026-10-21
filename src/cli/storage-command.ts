// `dovet gc` and `dovet sessions …` (cli-config "Commands", event-log "Disk use"). No process.* here; main.ts wires it.
import type { Settings } from "../schema/index.ts";
import {
  dataSize,
  deleteStored,
  formatBytes,
  type GcReport,
  type GcSettings,
  listStored,
  parseSize,
  runGc,
  sizeWarning,
} from "../store/index.ts";

export type StorageInput = {
  data: string;
  now: number;
  settings: GcSettings & { warnAtGB: number };
  /** The environment git runs in. */
  env: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
};

type Result = { output: string; exitCode: number };

/** The retention settings (cli-config defaults when a key is missing). */
export function storageSettings(retention: Settings["retention"]): StorageInput["settings"] {
  return {
    days: retention?.days ?? 30,
    deleteSessions: retention?.deleteSessions ?? false,
    outputsDays: retention?.outputsDays ?? 7,
    warnAtGB: retention?.warnAtGB ?? 10,
  };
}

const USAGE = [
  "usage: dovet gc",
  "       dovet sessions list [--size]",
  "       dovet sessions delete <id> | --older-than <days> | --larger-than <size>",
  "",
].join("\n");

function describeGc(report: GcReport): string {
  if (report.skipped !== undefined) return `GC did not run: ${report.skipped}.\n`;
  const out = [
    `Removed ${report.blobsRemoved} unreferenced blobs (${formatBytes(report.bytesFreed)}), ${report.offloadRemoved} expired output files and ${report.sessionsDeleted.length} sessions.`,
  ];
  for (const p of report.projectsSkipped)
    out.push(`Left the snapshots of project ${p} alone: a session is running in it.`);
  for (const p of report.problems) out.push(`Problem: ${p}`);
  return `${out.join("\n")}\n`;
}

export async function runStorageCommand(argv: readonly string[], input: StorageInput): Promise<Result> {
  const [command, sub, ...rest] = argv;
  if (command === "gc" && sub === undefined) {
    const report = await runGc(input);
    return { output: describeGc(report), exitCode: report.problems.length > 0 ? 1 : 0 };
  }
  if (command !== "sessions") return { output: USAGE, exitCode: 2 };
  if (sub === "list" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--size"))) {
    const stored = await listStored(input.data, input.now);
    if (rest.length === 1) stored.sort((a, b) => b.bytes - a.bytes);
    const rows = stored.map(
      (s) =>
        `${s.id}  ${new Date(s.modified).toISOString().slice(0, 10)}  ${formatBytes(s.bytes).padStart(9)}  ${s.project}${s.active ? "  (running)" : ""}`,
    );
    const total = `${stored.length} sessions, ${formatBytes(await dataSize(input.data))} in ${input.data}`;
    return { output: `${[...rows, total].join("\n")}\n`, exitCode: 0 };
  }
  if (sub !== "delete") return { output: USAGE, exitCode: 2 };
  const [first, value, ...extra] = rest;
  if (first === undefined || extra.length > 0) return { output: USAGE, exitCode: 2 };
  let pick: Parameters<typeof deleteStored>[2];
  if (first === "--older-than") {
    const days = Number(value);
    if (value === undefined || !Number.isFinite(days) || days < 0)
      return { output: "--older-than needs a number of days\n", exitCode: 2 };
    pick = { olderThanDays: days };
  } else if (first === "--larger-than") {
    const bytes = value === undefined ? undefined : parseSize(value);
    if (bytes === undefined) return { output: "--larger-than needs a size such as 500MB or 2GB\n", exitCode: 2 };
    pick = { largerThanBytes: bytes };
  } else if (!first.startsWith("-") && value === undefined) pick = { ids: [first] };
  else return { output: USAGE, exitCode: 2 };

  const result = await deleteStored(input.data, input.now, pick);
  const out = result.deleted.map((s) => `Deleted ${s.id} (${formatBytes(s.bytes)}, ${s.project})`);
  for (const s of result.skippedActive) out.push(`Kept ${s.id}: a Dovet process is using it.`);
  for (const id of result.missing) out.push(`No stored session ${id}.`);
  if (result.deleted.length > 0) out.push(describeGc(await runGc(input)).trimEnd());
  if (out.length === 0) out.push("No sessions matched.");
  return { output: `${out.join("\n")}\n`, exitCode: result.missing.length > 0 ? 1 : 0 };
}

/**
 * Startup housekeeping (event-log "Disk use"): the once-a-day size warning and a background GC. Resolves with the lines
 * to show; never rejects, so a failure is printed rather than lost.
 */
export async function runMaintenance(input: StorageInput): Promise<string[]> {
  const lines: string[] = [];
  try {
    const warning = await sizeWarning({ data: input.data, warnAtGB: input.settings.warnAtGB, now: input.now });
    if (warning !== undefined) lines.push(warning);
    const report = await runGc(input);
    for (const p of report.problems) lines.push(`GC: ${p}`);
  } catch (err) {
    lines.push(`GC could not run (${err instanceof Error ? err.message : String(err)})`);
  }
  return lines;
}
