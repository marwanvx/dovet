// Streaming resume with the sidecar fast path, crash recovery, fork offers and the repair epoch (event-log "Resume").
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { isErrno } from "../../platform/index.ts";
import { EVENT_TYPES, EventEnvelope, type EventType, type StoredResponse } from "../../schema/index.ts";
import { writePrivateAtomic } from "./files.ts";
import { type SessionLocation, sessionPaths } from "./paths.ts";

export const CRASH_TOOL_TEXT =
  "Not run or not finished: Dovet exited before this tool completed. Check the current state before retrying.";
export const REPAIR_HINT = "dovet --resume <id> --repair";

export type ResumeSnapshot = {
  mode: string;
  taint: string[];
  turn: number;
  costUsd: number;
  provider: string;
  model: string;
};
export type ResumeState = ResumeSnapshot & {
  epoch: number;
  toolsJson: string;
  systemText: string;
  thinking: { mode: "adaptive" | "enabled" | "off"; budgetTokens?: number };
  promptVersion: string;
  lastEventId: string;
};
export type RepairOp = { type: EventType; epoch: number; turn: number | null; data: unknown };
export type ResumeResult = {
  state: ResumeState;
  warnings: string[];
  readOnly?: string;
  forkTurn?: number | null;
  repairs: RepairOp[];
  fastPath: boolean;
  lines: number;
};

const emptyState = (): ResumeState => ({
  mode: "default",
  taint: [],
  turn: 0,
  costUsd: 0,
  provider: "",
  model: "",
  epoch: 0,
  toolsJson: "[]",
  systemText: "",
  thinking: { mode: "off" },
  promptVersion: "",
  lastEventId: "",
});

function dataOf(e: { data: unknown }): Record<string, unknown> {
  return typeof e.data === "object" && e.data !== null ? (e.data as Record<string, unknown>) : {};
}

/** Non-retryable history rejections unlock the repair epoch; every other failure is not history (event-log "Resume"). */
export function isHistoryRelated(err: { kind: string; retryable: boolean; message?: string }): boolean {
  if (err.kind !== "invalid_request" || err.retryable) return false;
  return /histor|replay|transcript|tool_result|tool_use|prefix|message|block/i.test(err.message ?? "");
}

type Item = {
  kind: string;
  parts?: Array<{ kind: string; text?: string; summary?: string; content?: unknown }>;
  stored?: { parts: Array<{ kind: string; text?: string; summary?: string }> };
};

/** Dovet never writes content the APIs reject; a violation here is a bug (event-log "Resume", InvariantViolation). */
export function validateTranscriptItems(items: readonly Item[]): void {
  for (const item of items) {
    const parts = item.kind === "assistant" ? (item.stored?.parts ?? []) : (item.parts ?? []);
    for (const p of parts) {
      if (p.kind === "text" && (p.text ?? "").trim() === "")
        throw new Error("InvariantViolation: empty or whitespace-only text block");
      if (p.kind === "padding") throw new Error("InvariantViolation: padding block");
      if (p.kind === "tool_result") {
        const content = (p as { content?: unknown }).content;
        if (Array.isArray(content)) {
          if (content.length === 0 || content.some((c) => c?.kind !== "text" || typeof c?.text !== "string"))
            throw new Error("InvariantViolation: non-text tool output");
        }
      }
    }
    if (item.kind === "assistant" && parts.length > 0 && parts.every((p) => p.kind === "reasoning")) {
      throw new Error("InvariantViolation: assistant turn with only reasoning");
    }
  }
}

/** The repair epoch drops provider-opaque reasoning, empty blocks and unpaired items, like a model switch. */
export function normalizeForRepair(stored: StoredResponse, pairedCallIds?: ReadonlySet<string>): StoredResponse | null {
  const parts = stored.parts.filter((p) => {
    if (p.kind === "reasoning") return false;
    if (p.kind === "text" && p.text.trim() === "") return false;
    if (p.kind === "tool_call" && pairedCallIds !== undefined && !pairedCallIds.has(p.id)) return false;
    return true;
  });
  return parts.length === 0 ? null : { ...stored, parts };
}

export function repairEpochEvent(state: ResumeState): { epoch: number; data: unknown } {
  return {
    epoch: state.epoch + 1,
    data: {
      epoch: state.epoch + 1,
      reason: "repair",
      provider: state.provider,
      model: state.model,
      systemText: state.systemText,
      toolsJson: state.toolsJson,
      thinking: state.thinking,
      promptVersion: state.promptVersion,
    },
  };
}

type Fold = {
  state: ResumeState;
  calls: Map<string, { turn: number; epoch: number }>;
  perms: Map<string, { turn: number; epoch: number; callId?: string }>;
  maxTurn: number;
  lastTurnEnd: number | null;
  epochMark: { offset: number; id: string; before: ResumeSnapshot } | null;
};

function foldEvent(f: Fold, e: EventEnvelope): void {
  const s = f.state;
  const d = dataOf(e);
  s.lastEventId = e.id;
  if (typeof e.turn === "number" && e.turn > f.maxTurn) f.maxTurn = e.turn;
  if (e.type === "session.start" && typeof d.mode === "string") s.mode = d.mode;
  if (e.type === "session.start" && typeof d.permissionMode === "string") s.mode = d.permissionMode;
  if (e.type === "settings.change" && d.key === "mode" && typeof d.new === "string") s.mode = d.new;
  if (e.type === "taint.change" && typeof d.source === "string") {
    if (d.tainted === false) s.taint = s.taint.filter((t) => t !== (d.source as string));
    else if (!s.taint.includes(d.source as string)) s.taint.push(d.source as string);
  }
  if (e.type === "receipt") {
    const cost = d.cost as { sessionUsd?: unknown } | undefined;
    const v =
      typeof d.sessionUsd === "number"
        ? d.sessionUsd
        : typeof cost?.sessionUsd === "number"
          ? cost.sessionUsd
          : undefined;
    if (v !== undefined) s.costUsd = v;
    if (typeof d.turn === "number" && d.turn > s.turn) s.turn = d.turn;
  }
  if (e.type === "epoch.start") {
    f.epochMark = {
      offset: -1,
      id: e.id,
      before: {
        mode: s.mode,
        taint: [...s.taint],
        turn: s.turn,
        costUsd: s.costUsd,
        provider: s.provider,
        model: s.model,
      },
    };
    if (typeof d.epoch === "number") s.epoch = d.epoch;
    if (typeof d.provider === "string") s.provider = d.provider;
    if (typeof d.model === "string") s.model = d.model;
    if (typeof d.toolsJson === "string") s.toolsJson = d.toolsJson;
    if (typeof d.systemText === "string") s.systemText = d.systemText;
    if (typeof d.promptVersion === "string") s.promptVersion = d.promptVersion;
    const th = d.thinking as ResumeState["thinking"] | undefined;
    if (th !== undefined && (th.mode === "adaptive" || th.mode === "enabled" || th.mode === "off")) s.thinking = th;
  }
  if (e.type === "tool.call" && typeof d.callId === "string") {
    f.calls.set(d.callId, { turn: e.turn ?? 0, epoch: e.epoch });
  }
  if (e.type === "tool.result" && typeof d.callId === "string") f.calls.delete(d.callId);
  if (e.type === "permission.request") {
    const id = typeof d.requestId === "string" ? d.requestId : typeof d.id === "string" ? d.id : e.id;
    const callId = typeof d.callId === "string" ? d.callId : undefined;
    f.perms.set(id, { turn: e.turn ?? 0, epoch: e.epoch, ...(callId === undefined ? {} : { callId }) });
  }
  if (e.type === "permission.decision") {
    const id = typeof d.requestId === "string" ? d.requestId : typeof d.id === "string" ? d.id : undefined;
    if (id !== undefined) f.perms.delete(id);
  }
  if (e.type === "turn.end" && typeof e.turn === "number") {
    f.lastTurnEnd = f.lastTurnEnd === null ? e.turn : Math.max(f.lastTurnEnd, e.turn);
    if (e.turn > s.turn) s.turn = e.turn;
  }
}

function crashRepairs(f: Fold): RepairOp[] {
  const out: RepairOp[] = [];
  for (const [id, p] of f.perms) {
    out.push({
      type: "permission.decision",
      epoch: p.epoch,
      turn: p.turn,
      data: { requestId: id, decision: "no", source: "interrupted" },
    });
    if (p.callId !== undefined && f.calls.has(p.callId)) {
      out.push({
        type: "tool.result",
        epoch: p.epoch,
        turn: p.turn,
        data: { callId: p.callId, status: "interrupted", output: CRASH_TOOL_TEXT },
      });
      f.calls.delete(p.callId);
    }
  }
  for (const [callId, c] of f.calls) {
    out.push({
      type: "tool.result",
      epoch: c.epoch,
      turn: c.turn,
      data: { callId, status: "interrupted", output: CRASH_TOOL_TEXT },
    });
  }
  const open = f.maxTurn > (f.lastTurnEnd ?? 0) ? f.maxTurn : null;
  if (open !== null) {
    out.push({ type: "turn.end", epoch: f.state.epoch, turn: open, data: { reason: "crashed" } });
    out.push({
      type: "receipt",
      epoch: f.state.epoch,
      turn: open,
      data: { turn: open, reason: "crashed", cost: { sessionUsd: f.state.costUsd } },
    });
  }
  return out;
}

async function readLineAt(path: string, offset: number): Promise<string | undefined> {
  const h = await open(path, "r").catch(() => undefined);
  if (h === undefined) return undefined;
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await h.read(buf, 0, buf.length, offset);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const nl = text.indexOf("\n");
    return nl === -1 ? undefined : text.slice(0, nl);
  } finally {
    await h.close();
  }
}

async function* streamLines(path: string, start: number): AsyncGenerator<string, { trailing: string }> {
  let leftover = Buffer.alloc(0);
  let trailing = "";
  const stream = createReadStream(path, { start });
  try {
    for await (const chunk of stream) {
      leftover = Buffer.concat([leftover, chunk as Buffer]);
      let nl = leftover.indexOf(0x0a);
      while (nl !== -1) {
        yield leftover.subarray(0, nl).toString("utf8");
        leftover = leftover.subarray(nl + 1);
        nl = leftover.indexOf(0x0a);
      }
    }
  } finally {
    stream.destroy();
  }
  trailing = leftover.toString("utf8");
  return { trailing };
}

/** Read the JSONL as a stream, line by line, validate every event and rebuild the session state (event-log "Resume"). */
export async function resumeSession(loc: SessionLocation): Promise<ResumeResult> {
  const { log, meta } = sessionPaths(loc);
  const warnings: string[] = [];
  const size = await stat(log).then(
    (st) => st.size,
    (err: unknown) => (isErrno(err, "ENOENT") ? 0 : Promise.reject(err)),
  );
  if (size === 0) return { state: emptyState(), warnings, repairs: [], fastPath: false, lines: 0 };

  const f: Fold = {
    state: emptyState(),
    calls: new Map(),
    perms: new Map(),
    maxTurn: 0,
    lastTurnEnd: null,
    epochMark: null,
  };
  let start = 0;
  let fastPath = false;
  const sidecar = await readFile(meta, "utf8").then(
    (t) => {
      try {
        return JSON.parse(t) as { epochOffset?: unknown; epochEventId?: unknown; snapshot?: unknown };
      } catch {
        return undefined;
      }
    },
    (err: unknown) => (isErrno(err, "ENOENT") ? undefined : Promise.reject(err)),
  );
  if (
    sidecar !== undefined &&
    typeof sidecar.epochOffset === "number" &&
    typeof sidecar.epochEventId === "string" &&
    sidecar.epochOffset < size
  ) {
    const first = await readLineAt(log, sidecar.epochOffset);
    if (first !== undefined) {
      try {
        const raw = JSON.parse(first) as { id?: unknown; type?: unknown };
        if (raw.id === sidecar.epochEventId && raw.type === "epoch.start") {
          const snap = sidecar.snapshot as ResumeSnapshot | undefined;
          if (snap !== undefined && typeof snap === "object") {
            f.state = {
              ...emptyState(),
              ...snap,
              toolsJson: "[]",
              systemText: "",
              thinking: { mode: "off" },
              promptVersion: "",
              lastEventId: "",
            };
          }
          start = sidecar.epochOffset;
          fastPath = true;
        }
      } catch {
        fastPath = false;
      }
    }
  }

  let n = 0;
  let offset = start;
  let failedAt: number | undefined;
  let failReason = "";
  const gen = streamLines(log, start);
  for (;;) {
    const next = await gen.next();
    if (next.done === true) {
      if (next.value.trailing !== "") {
        n += 1;
        warnings.push(`line ${n}: ignored an incomplete last line (Dovet stopped while writing it)`);
      }
      break;
    }
    const line = next.value;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    n += 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // A torn line is acceptable only next to the writer's crash-repair marker naming it (event-log "Writer rules" 4).
      // In a fast-path scan line numbers are relative to the epoch offset, so the number matches only on full scans.
      const peeked = await gen.next();
      const marker = (() => {
        if (peeked.done === true) return undefined;
        try {
          const p = EventEnvelope.safeParse(JSON.parse(peeked.value));
          if (!p.success || p.data.type !== "session.resume") return undefined;
          const d = dataOf(p.data);
          return d.reason === "crash-repair" && (d.tornLine === n || fastPath) ? peeked.value : undefined;
        } catch {
          return undefined;
        }
      })();
      if (marker === undefined) {
        failedAt = n;
        failReason = "the line is not valid JSON";
        break;
      }
      warnings.push(`line ${n}: ignored an incomplete line (Dovet stopped while writing it)`);
      offset += lineBytes + Buffer.byteLength(marker, "utf8") + 1;
      n += 1;
      continue;
    }
    const parsed = EventEnvelope.safeParse(raw);
    if (!parsed.success) {
      failedAt = n;
      failReason = `invalid event: ${parsed.error.issues[0]?.message ?? "unknown"}`;
      break;
    }
    const event = parsed.data;
    const known = EVENT_TYPES.get(event.type);
    if (known === undefined && event.core) {
      failedAt = n;
      failReason = `unknown core event type "${event.type}" (written by a newer Dovet?)`;
      break;
    }
    if (known === undefined) {
      warnings.push(`line ${n}: skipped unknown optional event type "${event.type}"`);
      offset += lineBytes;
      continue;
    }
    if (known.core !== event.core) {
      failedAt = n;
      failReason = `event type "${event.type}" has the wrong core flag`;
      break;
    }
    foldEvent(f, event);
    if (f.epochMark !== null && f.epochMark.offset === -1) f.epochMark.offset = offset;
    offset += lineBytes;
  }

  if (failedAt !== undefined) {
    return {
      state: f.state,
      warnings,
      readOnly: `line ${failedAt}: ${failReason}`,
      forkTurn: f.lastTurnEnd,
      repairs: [],
      fastPath: false,
      lines: n,
    };
  }
  const repairs = crashRepairs(f);
  if (f.epochMark !== null && f.epochMark.offset >= 0) {
    const existing = await readFile(meta, "utf8").then(
      (t) => {
        try {
          return JSON.parse(t) as Record<string, unknown>;
        } catch {
          return {};
        }
      },
      () => ({}),
    );
    const m = f.epochMark;
    await writePrivateAtomic(
      meta,
      `${JSON.stringify({ ...existing, bytes: size, epoch: f.state.epoch, epochOffset: m.offset, epochEventId: m.id, snapshot: m.before })}\n`,
    ).catch(() => {
      warnings.push("the sidecar could not be updated; the next resume takes the slow path");
    });
  } else {
    const existing = await readFile(meta, "utf8").then(
      (t) => {
        try {
          return JSON.parse(t) as Record<string, unknown>;
        } catch {
          return {};
        }
      },
      () => ({}),
    );
    await writePrivateAtomic(meta, `${JSON.stringify({ ...existing, bytes: size })}\n`).catch(() => {
      warnings.push("the sidecar could not be updated; the next resume takes the slow path");
    });
  }
  return { state: f.state, warnings, repairs, fastPath, lines: n };
}

/** Yield a log's lines without holding the file in memory; a torn tail is dropped, never yielded. */
async function* linesOf(path: string): AsyncGenerator<string> {
  const gen = streamLines(path, 0);
  try {
    for (;;) {
      const next = await gen.next();
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    await gen.return?.({ trailing: "" });
  }
}

/** Copy a damaged log's events through its last complete turn into a new session; the original is never touched. */
export async function forkSession(
  loc: SessionLocation,
  session: string,
  uptoTurn: number,
  deps: { ids: { ulid(): string }; clock: { now(): number } },
): Promise<{ loc: SessionLocation; copied: number; parentEvent: string }> {
  const { log } = sessionPaths(loc);
  const next: SessionLocation = { ...loc, session };
  const paths = sessionPaths(next);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const out = await open(paths.log, "wx", 0o600);
  let copied = 0;
  let parentEvent = "";
  let uptoEpoch = 0;
  const it = linesOf(log);
  try {
    let buffered: string | undefined;
    const take = async (): Promise<string | undefined> => {
      if (buffered !== undefined) {
        const l = buffered;
        buffered = undefined;
        return l;
      }
      const r = await it.next();
      return r.done === true ? undefined : r.value;
    };
    for (;;) {
      const line = await take();
      if (line === undefined) break;
      if (line === "") continue;
      let e: EventEnvelope | undefined;
      try {
        const parsed = EventEnvelope.safeParse(JSON.parse(line));
        if (parsed.success) e = parsed.data;
      } catch {
        e = undefined;
      }
      if (e === undefined) {
        // Skip writer-repaired torn lines like the reader does, instead of truncating the fork there.
        const peek = await take();
        const marker =
          peek !== undefined
            ? (() => {
                try {
                  const p = EventEnvelope.safeParse(JSON.parse(peek));
                  if (!p.success || p.data.type !== "session.resume") return undefined;
                  return dataOf(p.data).reason === "crash-repair" ? peek : undefined;
                } catch {
                  return undefined;
                }
              })()
            : undefined;
        if (marker === undefined) {
          if (peek !== undefined) buffered = peek;
          break;
        }
        continue;
      }
      if (e.type === "epoch.start" && e.epoch > uptoEpoch && copied > 0 && parentEvent !== "") break;
      if (e.type === "epoch.start" && typeof (e.data as { epoch?: unknown }).epoch === "number") {
        uptoEpoch = Math.max(uptoEpoch, (e.data as { epoch: number }).epoch);
      }
      if (typeof e.turn === "number" && e.turn > uptoTurn) break;
      await out.appendFile(`${line}\n`);
      copied += 1;
      parentEvent = e.id;
      if (e.type === "turn.end" && e.turn === uptoTurn) uptoEpoch = e.epoch;
    }
    const fork = {
      v: 1,
      id: deps.ids.ulid(),
      ts: new Date(deps.clock.now()).toISOString(),
      session,
      epoch: uptoEpoch,
      turn: null,
      type: "session.fork",
      core: true,
      data: { parent: loc.session, parentEvent },
    };
    await out.appendFile(`${JSON.stringify(fork)}\n`);
  } finally {
    await it.return?.(undefined);
    await out.close();
  }
  return { loc: next, copied, parentEvent };
}
