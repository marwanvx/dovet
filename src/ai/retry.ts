// The retry policy and stream timeouts (providers §6b and §7, agent-loop "Stream liveness and timeouts").
import type { FetchFunction } from "./sdk-adapter.ts";
import type { ProviderErrorInfo, ProviderRequest, RenderInput, SdkCall, StreamEvent, TranscriptItem } from "./types.ts";

export const MAX_ATTEMPTS = 6;
export const STREAM_IDLE_TIMEOUT_MS = 180_000;
const BASE_MS = 2_000;
const CAP_MS = 60_000;
const MIN_MS = 1_000;

export const NOT_RUN_AFTER_DROP =
  "Not run: the connection dropped before your response finished. Re-issue the call if it is still needed.";
export const CONTINUE_AFTER_DROP =
  "Your previous response was cut off by a connection error after the blocks above. Continue from there.";

export type RetryDeps = {
  adapter: {
    render(input: RenderInput): SdkCall;
    stream(
      call: SdkCall,
      opts: { signal: AbortSignal; onRequest: (req: ProviderRequest) => void },
    ): AsyncIterable<StreamEvent>;
  };
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** In [0, 1), for the backoff's full jitter. */
  random(): number;
};

type Live = Extract<
  StreamEvent,
  { type: "text.delta" | "reasoning.delta" | "tool_call.start" | "tool_call.delta" | "block.done" | "usage" }
>;

/** `request` → `model.request`, `attempt.error` → `model.error`, `retrying` → the status line (event-log, tui). */
export type CallEvent =
  | Live
  | { type: "request"; attempt: number; request: ProviderRequest }
  | { type: "attempt.error"; attempt: number; error: ProviderErrorInfo; willRetry: boolean }
  | { type: "retrying"; attempt: number; of: number; delayMs: number; detail: string }
  /** The failed attempt's streamed output is dropped; the UI clears it. */
  | { type: "discarded"; attempt: number }
  /** Blocks that completed before a drop, and the items that answer them; appended to the transcript in this order. */
  | { type: "kept"; items: TranscriptItem[] }
  | Extract<StreamEvent, { type: "done" | "aborted" }>
  | { type: "failed"; error: ProviderErrorInfo };

const LABELS: Partial<Record<ProviderErrorInfo["kind"], string>> = {
  rate_limit: "rate limited",
  overloaded: "overloaded",
  server: "server error",
  network: "connection dropped",
  timeout: "no data from the provider",
};

function statusLine(attempt: number, delayMs: number, e: ProviderErrorInfo): string {
  const label = LABELS[e.kind] ?? e.kind;
  const reason = e.status === undefined || e.status < 300 ? label : `${label} (${e.status})`;
  const id = e.requestId === undefined ? "" : `, request id ${e.requestId}`;
  return `Retrying (${attempt}/${MAX_ATTEMPTS}) in ${Math.ceil(delayMs / 1000)}s — ${reason}${id}`;
}

/** Full jitter (base 2 s, factor 2, cap 60 s); `retry-after` wins; never under 1 s, even for `Retry-After: 0`. */
function delayFor(failures: number, e: ProviderErrorInfo, random: () => number): number {
  const ms = e.retryAfterMs ?? random() * Math.min(CAP_MS, BASE_MS * 2 ** (failures - 1));
  return Math.max(MIN_MS, Math.round(ms));
}

function continuation(completed: Extract<StreamEvent, { type: "error" }>["completed"] & object): TranscriptItem[] {
  const notRun = completed.parts.flatMap((p) =>
    p.kind === "tool_call"
      ? [
          {
            kind: "tool_result" as const,
            callId: p.id,
            isError: true,
            content: [{ kind: "text" as const, text: NOT_RUN_AFTER_DROP }],
          },
        ]
      : [],
  );
  return [
    { kind: "assistant", stored: completed },
    {
      kind: "user",
      parts: [...notRun, { kind: "instruction", reason: "continue-after-drop", text: CONTINUE_AFTER_DROP }],
    },
  ];
}

/** One model call: every cause of failure, including stream drops and continuations, shares one 6-attempt budget. */
export async function* callModel(
  input: RenderInput,
  deps: RetryDeps,
  opts: { signal: AbortSignal },
): AsyncIterable<CallEvent> {
  let transcript = input.transcript;
  for (let attempt = 1; ; attempt++) {
    const requests: ProviderRequest[] = [];
    let failure: Extract<StreamEvent, { type: "error" }> | undefined;
    const call = deps.adapter.render({ ...input, transcript });
    for await (const e of deps.adapter.stream(call, { signal: opts.signal, onRequest: (r) => requests.push(r) })) {
      for (const request of requests.splice(0)) yield { type: "request", attempt, request };
      if (e.type === "error") failure = e;
      else yield e;
    }
    for (const request of requests.splice(0)) yield { type: "request", attempt, request };
    if (failure === undefined) return;

    const willRetry = failure.error.retryable && attempt < MAX_ATTEMPTS;
    yield { type: "attempt.error", attempt, error: failure.error, willRetry };
    if (failure.completed === null) yield { type: "discarded", attempt };
    else {
      const items = continuation(failure.completed);
      transcript = [...transcript, ...items];
      yield { type: "kept", items };
    }
    if (!willRetry) {
      yield { type: "failed", error: failure.error };
      return;
    }
    const delayMs = delayFor(attempt, failure.error, deps.random);
    yield {
      type: "retrying",
      attempt: attempt + 1,
      of: MAX_ATTEMPTS,
      delayMs,
      detail: statusLine(attempt + 1, delayMs, failure.error),
    };
    await deps.sleep(delayMs, opts.signal);
    if (opts.signal.aborted) {
      yield { type: "aborted", completed: null };
      return;
    }
  }
}

function timeoutError(idleMs: number): DOMException {
  return new DOMException(`No data from the provider for ${Math.round(idleMs / 1000)} s.`, "TimeoutError");
}

/**
 * Aborts a request when no bytes arrive for `idleMs`: before the response starts, and between body chunks (SSE
 * keep-alive comments count). Bun's fetch has no separate connect timeout, so the first-byte deadline covers connecting.
 */
export function timedFetch(base: FetchFunction, opts: { idleMs: number }): FetchFunction {
  const timed = async (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]): Promise<Response> => {
    const idle = new AbortController();
    const signal = init?.signal == null ? idle.signal : AbortSignal.any([init.signal, idle.signal]);
    const arm = () => setTimeout(() => idle.abort(timeoutError(opts.idleMs)), opts.idleMs);
    const first = arm();
    let res: Response;
    try {
      res = await base(input, { ...init, signal });
    } catch (err) {
      throw idle.signal.aborted ? idle.signal.reason : err;
    } finally {
      clearTimeout(first);
    }
    if (res.body === null) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const timer = arm();
        try {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (err) {
          controller.error(idle.signal.aborted ? idle.signal.reason : err);
        } finally {
          clearTimeout(timer);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return Object.assign(timed, { preconnect: base.preconnect });
}
