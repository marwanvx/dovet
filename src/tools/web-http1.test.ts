import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { gzipSync } from "node:zlib";
import { readResponse, requestText } from "./web-http1.ts";

const servers: net.Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/** Connects to a server that sends `wire` as soon as the request arrives, then optionally closes. */
async function reply(wire: Array<string | Buffer>, close = true): Promise<Response> {
  const server = net.createServer((c) => {
    c.once("data", () => {
      for (const part of wire) c.write(part);
      if (close) c.end();
    });
    c.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const socket = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
  const res = readResponse(socket);
  socket.write(requestText(new URL("https://a.example/x"), {}));
  return res;
}

describe("HTTP/1.1 over a secured socket", () => {
  // spec: AC-TOOLS-51
  test("the request names the host, asks for the connection to close and never sends a header with a line break", () => {
    const text = requestText(new URL("https://a.example:8443/p?q=1"), { "User-Agent": "t", Host: "evil" });
    expect(text.startsWith("GET /p?q=1 HTTP/1.1\r\nHost: a.example:8443\r\n")).toBe(true);
    expect(text).toContain("User-Agent: t\r\n");
    expect(text).not.toContain("evil");
    expect(text.endsWith("Connection: close\r\n\r\n")).toBe(true);
    expect(() => requestText(new URL("https://a.example/"), { "X-A": "b\r\nX-Injected: 1" })).toThrow("can't be sent");
  });

  // spec: AC-TOOLS-51
  test("reads a Content-Length body split across packets, with the headers", async () => {
    const res = await reply([
      "HTTP/1.1 200 OK\r\nContent-Ty",
      "pe: text/plain\r\nContent-Length: 11\r\n\r\nhello ",
      "world",
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("hello world");
  });

  // spec: AC-TOOLS-51
  test("reads a chunked body, ignoring extensions and trailers", async () => {
    const res = await reply([
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhel",
      "lo\r\n6\r\n world\r\n0\r\nX-Trailer: 1\r\n\r\nIGNORED",
    ]);
    expect(await res.text()).toBe("hello world");
  });

  // spec: AC-TOOLS-51
  test("reads a body that ends when the server closes, and skips a 1xx reply", async () => {
    const res = await reply(["HTTP/1.1 103 Early Hints\r\nLink: x\r\n\r\nHTTP/1.1 200 OK\r\n\r\nuntil close"]);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("until close");
  });

  // spec: AC-TOOLS-51
  test("decodes a gzip body and drops the encoding headers", async () => {
    const body = gzipSync("compressed text");
    const res = await reply([
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n`,
      body,
    ]);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("compressed text");
  });

  // spec: AC-TOOLS-51
  test("a redirect without a body gives its status and Location", async () => {
    const res = await reply(["HTTP/1.1 302 Found\r\nLocation: https://b.example/\r\nContent-Length: 0\r\n\r\n"]);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://b.example/");
    expect(await res.text()).toBe("");
  });

  // spec: AC-TOOLS-51
  test("a 304 has no body to wait for", async () => {
    const res = await reply(["HTTP/1.1 304 Not Modified\r\nContent-Length: 50\r\n\r\n"], false);
    expect(res.status).toBe(304);
  });

  // spec: AC-TOOLS-51
  test("a connection that ends before the body is complete is an error, not a short page", async () => {
    const short = await reply(["HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nonly ten b"]);
    await expect(short.text()).rejects.toThrow("before the response was complete");
    const cut = await reply(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel"]);
    await expect(cut.text()).rejects.toThrow("before the response was complete");
  });

  // spec: AC-TOOLS-51
  test("a reply that isn't HTTP is refused", async () => {
    await expect(reply(["not http at all\r\n\r\n"])).rejects.toThrow("isn't HTTP/1.x");
  });

  // spec: AC-TOOLS-51
  test("headers that never end are cut off at the limit", async () => {
    await expect(reply([`HTTP/1.1 200 OK\r\nX: ${"a".repeat(70000)}`], false)).rejects.toThrow("headers are too long");
  });

  // spec: AC-TOOLS-51
  test("a bad Content-Length, an unsupported encoding and a silent server are refused", async () => {
    await expect(reply(["HTTP/1.1 200 OK\r\nContent-Length: abc\r\n\r\n"])).rejects.toThrow("Content-Length");
    await expect(reply(["HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n"])).rejects.toThrow("unsupported");
    await expect(reply(["HTTP/1.1 200 OK\r\nContent-Encoding: br\r\nContent-Length: 1\r\n\r\nx"])).rejects.toThrow(
      "content encoding",
    );
    await expect(reply([])).rejects.toThrow("before replying");
  });

  // spec: AC-TOOLS-51
  test("a chunk size that isn't hexadecimal fails the body", async () => {
    const badChunk = await reply(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"]);
    await expect(badChunk.text()).rejects.toThrow("malformed chunk size");
  });
});
