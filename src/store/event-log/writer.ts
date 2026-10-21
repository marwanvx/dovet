import { type FileHandle, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { isErrno } from "../../platform/index.ts";
import { EVENT_TYPES, type EventEnvelope, type EventType } from "../../schema/index.ts";
import { type BlobStore, createBlobStore } from "../blobs/index.ts";
import { writePrivateAtomic } from "./files.ts";
import { emptyMeta, foldMeta, SessionMeta } from "./meta.ts";
import { type SessionLocation, sessionPaths } from "./paths.ts";
import { readSession } from "./reader.ts";
import { orderSecrets, scrub } from "./redact.ts";

export type OpenInput = SessionLocation & {
  clock: { now(): number };
  ids: { ulid(): string };
  pid: number;
  host: string;
  /** Values never written: scrubbed from every string (`secretValuesFromEnv` plus resolved credentials). */
  secrets: readonly string[];
  flushMs?: number;
  heartbeatMs?: number;
};

export type AppendInput = { type: EventType; epoch: number; turn: number | null; data: unknown };

export interface SessionWriter {
  append(event: AppendInput): EventEnvelope;
  flush(): Promise<void>;
  /** Flushes, fsyncs and releases the lock; the caller appends `session.end` first on a clean exit. */
  close(): Promise<void>;
}

export type OpenResult = { mode: "write"; writer: SessionWriter } | { mode: "read-only"; reason: string };

const STALE_LOCK_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
const FLUSH_MS = 2_000;
const BLOB_OVER_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const FLUSH_NOW = new Set(["user.message", "turn.end", "permission.request", "session.end"]);
const FSYNC = new Set(["user.message", "turn.end", "session.end"]);

function moveLargeStrings(value: unknown, blobs: BlobStore): unknown {
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return bytes.length > BLOB_OVER_BYTES ? { $blob: blobs.putSync(bytes), bytes: bytes.length } : value;
  }
  if (Array.isArray(value)) return value.map((v) => moveLargeStrings(v, blobs));
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, moveLargeStrings(v, blobs)]));
    // Data that only looks like a blob reference (a model can write one) is wrapped so the reader keeps it as data.
    return "$blob" in value || "$lit" in value ? { $lit: out } : out;
  }
  return value;
}

function serialize(e: EventEnvelope): string {
  return `${JSON.stringify(e).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")}\n`;
}

/** Exclusive-create; a lock without a heartbeat for 2 minutes is taken over (event-log "Writer rules" 1). */
async function takeLock(lock: string, owner: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(lock, owner, { flag: "wx", mode: 0o600 });
      return undefined;
    } catch (err) {
      if (!isErrno(err, "EEXIST")) throw err;
    }
    const mtime = await stat(lock).then(
      (st) => st.mtimeMs,
      (err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)),
    );
    if (mtime !== undefined && Date.now() - mtime <= STALE_LOCK_MS) break;
    if (mtime === undefined) continue;
    // Rename, not delete: of two processes taking over the same stale lock, only one rename succeeds.
    const stale = `${lock}.${crypto.randomUUID()}.stale`;
    const moved = await rename(lock, stale).then(
      () => true,
      (err: unknown) => (isErrno(err, "ENOENT") ? false : Promise.reject(err)),
    );
    if (moved) await rm(stale, { force: true });
  }
  const holder = await readFile(lock, "utf8").then(
    (t) => {
      try {
        return JSON.parse(t) as { pid?: unknown; host?: unknown };
      } catch {
        return { pid: undefined, host: undefined };
      }
    },
    (err: unknown) => (isErrno(err, "ENOENT") ? { pid: undefined, host: undefined } : Promise.reject(err)),
  );
  const who =
    typeof holder.pid === "number" && typeof holder.host === "string"
      ? `pid ${holder.pid} on ${holder.host}`
      : "unknown process";
  return `this session is open in another Dovet process (${who}); opened read-only`;
}

export async function openSession(input: OpenInput): Promise<OpenResult> {
  const paths = sessionPaths(input);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const owner = JSON.stringify({
    pid: input.pid,
    host: input.host,
    started: new Date(input.clock.now()).toISOString(),
    token: crypto.randomUUID(),
  });
  const refused = await takeLock(paths.lock, owner);
  if (refused !== undefined) return { mode: "read-only", reason: refused };

  let existing: Existing;
  try {
    existing = await readExisting(input, paths);
  } catch (err) {
    await rm(paths.lock, { force: true });
    throw err;
  }
  if ("readOnly" in existing) {
    await rm(paths.lock, { force: true });
    return { mode: "read-only", reason: existing.readOnly };
  }
  const blobs = createBlobStore(input.data);
  const secrets = orderSecrets(input.secrets);
  let handle: FileHandle;
  try {
    handle = await open(paths.log, "a", 0o600);
    if (existing.tornLine !== undefined) await handle.appendFile("\n");
  } catch (err) {
    await rm(paths.lock, { force: true });
    throw err;
  }
  let queue: string[] = [];
  let meta: SessionMeta = existing.meta;
  let lastId = meta.lastId;
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown;
  let closed = false;

  const record = (err: unknown): void => {
    failure ??= err;
  };
  const check = (): void => {
    if (failure !== undefined) throw failure;
    if (closed) throw new Error("the session log is closed");
  };

  function write(opts: { fsync: boolean; sidecar?: SessionMeta }): Promise<void> {
    chain = chain.then(async () => {
      const text = queue.join("");
      queue = [];
      if (text !== "") await handle.appendFile(text);
      if (opts.fsync) await handle.sync();
      if (opts.sidecar !== undefined) {
        const bytes = (await handle.stat()).size;
        await writePrivateAtomic(paths.meta, `${JSON.stringify({ ...opts.sidecar, bytes })}\n`);
      }
    });
    return chain;
  }

  const flushTimer = setInterval(() => {
    if (queue.length > 0) write({ fsync: false }).catch(record);
  }, input.flushMs ?? FLUSH_MS);
  const beat = async (): Promise<void> => {
    const current = await readFile(paths.lock, "utf8").catch((err: unknown) =>
      isErrno(err, "ENOENT") ? "" : Promise.reject(err),
    );
    if (current !== owner) throw new Error("another Dovet process took over this session; this one stopped writing");
    const now = new Date();
    await utimes(paths.lock, now, now);
  };
  const heartbeat = setInterval(() => {
    beat().catch(record);
  }, input.heartbeatMs ?? HEARTBEAT_MS);
  flushTimer.unref();
  heartbeat.unref();

  const writer: SessionWriter = {
    append({ type, epoch, turn, data }) {
      check();
      const kind = EVENT_TYPES.get(type);
      if (kind === undefined) throw new Error(`unknown event type "${type}"`);
      const id = input.ids.ulid();
      if (id <= lastId) throw new Error(`event id ${id} is not after ${lastId}`);
      lastId = id;
      const ts = new Date(input.clock.now()).toISOString();
      const clean = scrub(data, secrets);
      meta = foldMeta(meta, { id, ts, type, data: clean });
      const envelope: EventEnvelope = {
        v: 1,
        id,
        ts,
        session: input.session,
        epoch,
        turn,
        type,
        core: kind.core,
        data: moveLargeStrings(clean, blobs),
      };
      const line = serialize(envelope);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES)
        throw new Error(`a ${type} event is over 1 MB after moving large strings to blobs`);
      queue.push(line);
      if (FLUSH_NOW.has(type)) {
        write({ fsync: FSYNC.has(type), ...(type === "turn.end" ? { sidecar: meta } : {}) }).catch(record);
      }
      return envelope;
    },

    async flush() {
      check();
      await write({ fsync: false });
      check();
    },

    async close() {
      if (closed) return;
      clearInterval(flushTimer);
      clearInterval(heartbeat);
      await write({ fsync: true }).catch(record);
      closed = true;
      await handle.close();
      const current = await readFile(paths.lock, "utf8").catch((err: unknown) =>
        isErrno(err, "ENOENT") ? "" : Promise.reject(err),
      );
      if (current === owner) await rm(paths.lock, { force: true });
      if (failure !== undefined) throw failure;
    },
  };
  if (existing.tornLine !== undefined) {
    writer.append({
      type: "session.resume",
      epoch: 0,
      turn: null,
      data: { reason: "crash-repair", tornLine: existing.tornLine },
    });
  }
  return { mode: "write", writer };
}

type Existing = { meta: SessionMeta; tornLine?: number } | { readOnly: string };

/** What a reopened log already holds; a torn last line gets `\n` and a `session.resume` naming it, so the log stays readable. */
async function readExisting(input: OpenInput, paths: { log: string; meta: string }): Promise<Existing> {
  const size = await stat(paths.log).then(
    (st) => st.size,
    (err: unknown) => (isErrno(err, "ENOENT") ? 0 : Promise.reject(err)),
  );
  if (size === 0) return { meta: emptyMeta(input.session) };
  const sidecar = await readFile(paths.meta, "utf8").then(
    (t) => {
      try {
        return SessionMeta.safeParse(JSON.parse(t)).data;
      } catch {
        return undefined;
      }
    },
    (err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)),
  );
  if (sidecar !== undefined && sidecar.bytes === size) return { meta: sidecar };
  const read = await readSession(input);
  if (read.readOnly !== undefined) return { readOnly: read.readOnly };
  const meta = read.events.reduce(foldMeta, emptyMeta(input.session));
  return read.tornLine === undefined ? { meta } : { meta, tornLine: read.tornLine };
}
