import { isErrno } from "../../platform/index.ts";
import { EVENT_TYPES, EventEnvelope } from "../../schema/index.ts";
import { type BlobStore, createBlobStore } from "../blobs/index.ts";
import { type SessionLocation, sessionPaths } from "./paths.ts";

export type ReadResult = {
  events: EventEnvelope[];
  warnings: string[];
  /** Set when the session can't be continued: the exact reason. Events before the problem are still returned. */
  readOnly?: string;
};

class ReadOnly extends Error {}

function isBlobRef(v: object): v is { $blob: string; bytes: number } {
  const keys = Object.keys(v);
  return (
    keys.length === 2 &&
    "$blob" in v &&
    "bytes" in v &&
    typeof v.$blob === "string" &&
    /^[0-9a-f]{64}$/.test(v.$blob) &&
    typeof v.bytes === "number"
  );
}

async function resolveBlobs(value: unknown, blobs: BlobStore): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveBlobs(v, blobs)));
  if (typeof value !== "object" || value === null) return value;
  if (isBlobRef(value)) {
    const bytes = await blobs.get(value.$blob);
    if (bytes === undefined) throw new ReadOnly(`essential blob ${value.$blob} is missing`);
    return new TextDecoder().decode(bytes);
  }
  const entries = await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveBlobs(v, blobs)]));
  return Object.fromEntries(entries);
}

async function parseLine(line: string, last: boolean, blobs: BlobStore, warnings: string[], n: number) {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    if (last) {
      warnings.push(`line ${n}: ignored an incomplete last line (Dovet stopped while writing it)`);
      return undefined;
    }
    throw new ReadOnly("the line is not valid JSON");
  }
  const v = (raw as { v?: unknown } | null)?.v;
  if (v !== 1) throw new ReadOnly(`unsupported event schema version ${JSON.stringify(v)}`);
  const parsed = EventEnvelope.safeParse(raw);
  if (!parsed.success) throw new ReadOnly(`invalid event: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  const event = parsed.data;
  const known = EVENT_TYPES.get(event.type);
  if (known === undefined && event.core) {
    throw new ReadOnly(`unknown core event type "${event.type}" (written by a newer Dovet?)`);
  }
  if (known === undefined) {
    warnings.push(`line ${n}: skipped unknown optional event type "${event.type}"`);
    return undefined;
  }
  if (known.core !== event.core) throw new ReadOnly(`event type "${event.type}" has the wrong core flag`);
  return { ...event, data: await resolveBlobs(event.data, blobs) };
}

/** Streams the session log line by line and validates every event (event-log "Writer rules" 4, "Core vs optional events"). */
export async function readSession(loc: SessionLocation): Promise<ReadResult> {
  const { log } = sessionPaths(loc);
  const blobs = createBlobStore(loc.data);
  const result: ReadResult = { events: [], warnings: [] };
  let n = 0;
  const handle = async (line: string, last: boolean): Promise<boolean> => {
    n += 1;
    try {
      const event = await parseLine(line, last, blobs, result.warnings, n);
      if (event !== undefined) result.events.push(event);
      return true;
    } catch (err) {
      if (!(err instanceof ReadOnly)) throw err;
      result.readOnly = `line ${n}: ${err.message}`;
      return false;
    }
  };

  let rest = "";
  try {
    for await (const chunk of Bun.file(log).stream().pipeThrough(new TextDecoderStream())) {
      rest += chunk;
      let nl = rest.indexOf("\n");
      while (nl !== -1) {
        if (!(await handle(rest.slice(0, nl), false))) return result;
        rest = rest.slice(nl + 1);
        nl = rest.indexOf("\n");
      }
    }
  } catch (err) {
    if (isErrno(err, "ENOENT")) return result;
    throw err;
  }
  if (rest !== "") await handle(rest, true);
  return result;
}
