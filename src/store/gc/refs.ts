// What one session log keeps alive (event-log "Blob store": essential blobs vs rewind-only data).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isErrno } from "../../platform/index.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const ANY_HEX64 = /[0-9a-f]{64}/g;
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export type LogRefs = {
  /** Blobs a replay needs: size-guard `$blob` references and attachment/media `{ store: "blob", id }` references. */
  essential: Set<string>;
  /** Checkpoint "before" blobs and file-change hashes. */
  rewind: Set<string>;
  /** Git tree ids of the log's `checkpoint` events. */
  trees: Set<string>;
};

function walk(value: unknown, essential: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, essential);
  } else if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    if (typeof o.$blob === "string" && HEX64.test(o.$blob)) essential.add(o.$blob);
    if (o.store === "blob" && typeof o.id === "string" && HEX64.test(o.id)) essential.add(o.id);
    for (const v of Object.values(o)) walk(v, essential);
  }
}

function typed(type: unknown, data: unknown, refs: LogRefs): void {
  if (typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  const hash = (v: unknown): void => {
    if (typeof v === "string" && HEX64.test(v)) refs.rewind.add(v);
  };
  if (type === "file.change") {
    hash(d.before);
    hash(d.after);
  } else if (type === "checkpoint") {
    if (typeof d.tree === "string" && OBJECT_ID.test(d.tree)) refs.trees.add(d.tree);
    if (Array.isArray(d.files)) for (const f of d.files) hash((f as { before?: unknown } | null)?.before);
  }
}

/**
 * Streams the log line by line (logs reach gigabytes). A line that doesn't parse (a torn tail, a corrupt line the
 * session opens read-only over) keeps every 64-hex string in it as essential: a blob is never lost to a damaged line.
 */
export async function traceLog(path: string): Promise<LogRefs> {
  const refs: LogRefs = { essential: new Set(), rewind: new Set(), trees: new Set() };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!/\$blob|"blob"|"file\.change"|"checkpoint"/.test(line)) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        for (const m of line.matchAll(ANY_HEX64)) refs.essential.add(m[0]);
        continue;
      }
      if (typeof event !== "object" || event === null) continue;
      const { type, data } = event as { type?: unknown; data?: unknown };
      walk(data, refs.essential);
      typed(type, data, refs);
    }
  } catch (err) {
    // A log deleted since it was listed (`dovet sessions delete`, `project purge`) references nothing.
    if (!isErrno(err, "ENOENT")) throw err;
  }
  return refs;
}
