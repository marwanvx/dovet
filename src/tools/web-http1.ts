// HTTP/1.1 over a socket the caller already secured: Bun's node:https ignores a supplied connection (measured, Bun 1.4.3).

import type { Duplex } from "node:stream";

const HEAD_LIMIT = 65536;
const LINE_LIMIT = 4096;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class HttpProtocolError extends Error {}

/** The request for `url` as it goes on the wire; the connection is closed after the reply. */
export function requestText(url: URL, headers: Record<string, string>): string {
  const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`];
  for (const [name, value] of Object.entries({ "Accept-Encoding": "gzip, deflate", ...headers })) {
    if (!TOKEN.test(name) || /[\r\n\0]/.test(value)) throw new HttpProtocolError(`header ${name} can't be sent`);
    if (name.toLowerCase() !== "host") lines.push(`${name}: ${value}`);
  }
  lines.push("Connection: close", "", "");
  return lines.join("\r\n");
}

type Decoder = { write(chunk: Uint8Array): Uint8Array[]; readonly finished: boolean; readonly endsOnClose: boolean };

function lengthDecoder(length: number): Decoder {
  let remaining = length;
  return {
    write(chunk) {
      const take = chunk.subarray(0, remaining);
      remaining -= take.length;
      return take.length === 0 ? [] : [take];
    },
    get finished() {
      return remaining === 0;
    },
    endsOnClose: false,
  };
}

const closeDecoder: Decoder = { write: (chunk) => [chunk], finished: false, endsOnClose: true };

function chunkedDecoder(): Decoder {
  let state: "size" | "data" | "crlf" | "trailer" | "done" = "size";
  let line = "";
  let remaining = 0;
  return {
    write(chunk) {
      const out: Uint8Array[] = [];
      let i = 0;
      while (i < chunk.length && state !== "done") {
        if (state === "data") {
          const n = Math.min(remaining, chunk.length - i);
          out.push(chunk.subarray(i, i + n));
          i += n;
          remaining -= n;
          if (remaining === 0) state = "crlf";
          continue;
        }
        const byte = chunk[i++];
        if (state === "crlf") {
          if (byte === 10) state = "size";
          else if (byte !== 13) throw new HttpProtocolError("malformed chunk end");
          continue;
        }
        if (byte !== 10) {
          line += String.fromCharCode(byte ?? 0);
          if (line.length > LINE_LIMIT) throw new HttpProtocolError("chunk header too long");
          continue;
        }
        const text = line.replace(/\r$/, "");
        line = "";
        if (state === "trailer") {
          if (text === "") state = "done";
          continue;
        }
        const size = (text.split(";")[0] ?? "").trim();
        if (!/^[0-9a-fA-F]{1,12}$/.test(size)) throw new HttpProtocolError("malformed chunk size");
        remaining = Number.parseInt(size, 16);
        state = remaining === 0 ? "trailer" : "data";
      }
      return out;
    },
    get finished() {
      return state === "done";
    },
    endsOnClose: false,
  };
}

function parseHead(text: string): { status: number; headers: Headers } {
  const [statusLine = "", ...fields] = text.split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(statusLine)?.[1];
  if (status === undefined) throw new HttpProtocolError("the server's reply isn't HTTP/1.x");
  const headers = new Headers();
  for (const field of fields) {
    const colon = field.indexOf(":");
    const name = field.slice(0, colon);
    const value = field.slice(colon + 1).trim();
    if (colon < 1 || !TOKEN.test(name) || value.includes("\0")) throw new HttpProtocolError("malformed header line");
    headers.append(name, value);
  }
  return { status: Number(status), headers };
}

function framing(status: number, headers: Headers): Decoder | undefined {
  if (status === 204 || status === 205 || status === 304) return undefined;
  const transfer = headers.get("transfer-encoding")?.toLowerCase();
  if (transfer !== undefined) {
    if (transfer.split(",").pop()?.trim() !== "chunked")
      throw new HttpProtocolError(`unsupported ${transfer} encoding`);
    return chunkedDecoder();
  }
  const length = headers.get("content-length");
  if (length === null) return closeDecoder;
  if (!/^\d{1,15}$/.test(length.trim())) throw new HttpProtocolError("malformed Content-Length");
  return lengthDecoder(Number(length.trim()));
}

/** Reads one response off the socket; the body streams, and cancelling it or any socket error closes the socket. */
export function readResponse(socket: Duplex): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let head: Buffer = Buffer.alloc(0);
    let decoder: Decoder | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    let over = false;

    const fail = (e: Error): void => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(e);
      } else if (controller !== undefined && !over) {
        over = true;
        controller.error(e);
      }
    };
    const complete = (): void => {
      if (controller === undefined || over) return;
      over = true;
      controller.close();
      socket.destroy();
    };

    const start = (rest: Buffer, status: number, headers: Headers): void => {
      const framed = framing(status, headers);
      const encoding = headers.get("content-encoding")?.trim().toLowerCase() ?? "identity";
      const kind =
        encoding === "gzip" || encoding === "x-gzip" ? "gzip" : encoding === "deflate" ? "deflate" : undefined;
      if (framed !== undefined && encoding !== "identity" && kind === undefined)
        throw new HttpProtocolError(`unsupported ${encoding} content encoding`);
      settled = true;
      if (framed === undefined) {
        resolve(new Response(null, { status, headers }));
        socket.destroy();
        return;
      }
      decoder = framed;
      const raw = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          over = true;
          socket.destroy();
        },
      });
      let body = raw;
      if (kind !== undefined) {
        body = raw.pipeThrough(
          new DecompressionStream(kind) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
        );
        headers.delete("content-encoding");
        headers.delete("content-length");
      }
      resolve(new Response(body, { status, headers }));
      feed(rest);
    };

    const feed = (chunk: Buffer): void => {
      if (decoder === undefined || controller === undefined || over) return;
      for (const part of decoder.write(chunk)) controller.enqueue(part);
      if (decoder.finished) complete();
    };

    socket.on("data", (chunk: Buffer) => {
      try {
        if (settled) {
          feed(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        for (;;) {
          const end = head.indexOf("\r\n\r\n");
          if (end === -1) {
            if (head.length > HEAD_LIMIT) throw new HttpProtocolError("the reply's headers are too long");
            return;
          }
          const { status, headers } = parseHead(head.subarray(0, end).toString("latin1"));
          const rest = head.subarray(end + 4);
          if (status >= 200) {
            start(rest, status, headers);
            return;
          }
          if (status === 101) throw new HttpProtocolError("unexpected protocol switch");
          head = Buffer.from(rest);
        }
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    socket.on("error", fail);
    socket.on("close", () => {
      if (!settled) fail(new HttpProtocolError("the server closed the connection before replying"));
      else if (decoder?.endsOnClose) complete();
      else if (!over) fail(new HttpProtocolError("the connection closed before the response was complete"));
    });
  });
}
