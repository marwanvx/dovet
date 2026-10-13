// A raw HTTP/1.1 server whose responses stall, drop or end on cue, for transport failures Bun.serve can't produce cleanly.

export type Step = { send: string } | { wait: number } | "drop";
/** `delay` holds back the status line, as a server that never starts answering does. */
export type Scripted = { status?: number; headers?: Record<string, string>; delay?: number; steps: Step[] };

/** Each request gets the next response; "drop" closes the socket mid-body (no final chunk), as a reset connection does. */
export function startScriptedServer(responses: readonly Scripted[]): {
  baseURL: string;
  received: string[];
  stop(): void;
} {
  const received: string[] = [];
  const errors: unknown[] = [];
  const buffers = new Map<object, Buffer>();
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const bytes = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), data]);
        buffers.set(socket, bytes);
        const end = bytes.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/content-length:\s*(\d+)/i.exec(bytes.subarray(0, end).toString())?.[1] ?? 0);
        if (bytes.length - end - 4 < length) return;
        buffers.delete(socket);
        received.push(bytes.subarray(end + 4).toString());
        const next = responses[received.length - 1] ?? { status: 599, steps: [{ send: "no more scripted responses" }] };
        play(socket, next).catch((err: unknown) => {
          errors.push(err);
          socket.end();
        });
      },
    },
  });
  return {
    baseURL: `http://127.0.0.1:${listener.port}/v1`,
    received,
    stop: () => {
      listener.stop(true);
      if (errors.length > 0) throw new Error(`scripted server failed: ${String(errors[0])}`);
    },
  };
}

async function play(socket: { write(s: string): number; end(): void }, r: Scripted): Promise<void> {
  if (r.delay !== undefined) await Bun.sleep(r.delay);
  const headers = { "content-type": "text/event-stream", ...r.headers };
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  socket.write(`HTTP/1.1 ${r.status ?? 200} X\r\n${head}transfer-encoding: chunked\r\nconnection: close\r\n\r\n`);
  for (const step of r.steps) {
    if (step === "drop") {
      socket.end();
      return;
    }
    if ("wait" in step) await Bun.sleep(step.wait);
    else socket.write(`${Buffer.byteLength(step.send).toString(16)}\r\n${step.send}\r\n`);
  }
  socket.write("0\r\n\r\n");
  socket.end();
}
