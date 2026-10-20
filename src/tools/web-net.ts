// WebFetch's network layer (tools §9): which hosts are refused, and the transports that reach the rest.

import { lookup } from "node:dns/promises";
import { isIP, connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { TLSSocket, connect as tlsConnect } from "node:tls";
import { isSafeIpAddress } from "guarded-fetch";
import { readResponse, requestText } from "./web-http1.ts";

export type WebRequest = { url: URL; headers: Record<string, string>; signal: AbortSignal };

/** One request, redirects left to the caller (every hop is checked again). */
export type WebTransport = (req: WebRequest) => Promise<Response>;

/** A host the guard refused, or a failure the model should not retry. */
export class WebFetchRefused extends Error {}

/** Why a request failed in a way that retrying cannot fix (or can). */
export class WebFetchFailed extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function localHostText(host: string): string {
  return `WebFetch can't reach local or intranet hosts (${host}). Use curl through the shell for local servers.`;
}

/** The refusals that need no DNS: names without a dot, `localhost`, and private IP literals (tools §9). */
export function isLocalHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) !== 0) return !isSafeIpAddress(host);
  return !host.includes(".");
}

const CONNECT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]);

function causeCode(e: unknown): string | undefined {
  for (let cur: unknown = e, i = 0; i < 5 && cur instanceof Error; i++, cur = cur.cause) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function describeFailure(host: string, e: unknown): Error {
  const code = causeCode(e);
  if (code === "ENOTFOUND" || code === "EAI_NODATA" || code === "EAI_NONAME")
    return new WebFetchFailed(`DNS lookup failed for ${host}. Don't retry this URL.`, false);
  if (code !== undefined && /CERT|TLS|SSL|ERR_TLS|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/i.test(code))
    return new WebFetchFailed(`TLS error for ${host} (${code}). Don't retry this URL.`, false);
  if (code !== undefined && CONNECT_CODES.has(code))
    return new WebFetchFailed(`Could not connect to ${host} (${code}).`, true);
  return new WebFetchFailed(`Request to ${host} failed: ${e instanceof Error ? e.message : String(e)}`, true);
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

const MAX_ADDRESSES = 4;

/**
 * Resolves the host once, drops unsafe addresses, and connects to the checked address itself with the original
 * `Host` and TLS server name, so no second lookup can switch to a private one (SPIKE-45: `guarded-fetch` runs on
 * Bun only with its pre-check, because Bun replaces `undici`'s connector).
 */
export function pinnedTransport(
  deps: { resolve?: Resolver; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {},
): WebTransport {
  const resolve = deps.resolve ?? systemResolver;
  const send = deps.fetch ?? ((url, init) => fetch(url, init));
  return async ({ url, headers, signal }) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(host) !== 0;
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
    });
    aborted.catch(() => undefined);
    let found: string[];
    try {
      found = literal ? [host] : await Promise.race([resolve(host), aborted]);
    } catch (e) {
      if (signal.aborted) throw e;
      throw new WebFetchFailed(`DNS lookup failed for ${url.hostname}. Don't retry this URL.`, false);
    }
    const safe = found.filter((a) => isSafeIpAddress(a)).slice(0, MAX_ADDRESSES);
    if (safe.length === 0) throw new WebFetchRefused(localHostText(url.hostname));
    let last: unknown;
    for (const address of safe) {
      const target = new URL(url);
      target.hostname = isIP(address) === 6 ? `[${address}]` : address;
      try {
        return await send(target.href, {
          headers: { ...headers, Host: url.host },
          signal,
          redirect: "manual",
          ...(literal ? {} : { tls: { serverName: host } }),
        } as RequestInit);
      } catch (e) {
        if (signal.aborted) throw e;
        last = e;
      }
    }
    throw describeFailure(url.hostname, last);
  };
}

const PROXY_HEAD_LIMIT = 8192;

function openProxySocket(proxy: URL, signal: AbortSignal, open: Socket[]): Promise<Socket> {
  const port = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
  const host = proxy.hostname.replace(/^\[|\]$/g, "");
  return new Promise<Socket>((resolve, reject) => {
    const socket =
      proxy.protocol === "https:"
        ? tlsConnect({ host, port, servername: isIP(host) === 0 ? host : undefined })
        : netConnect({ host, port });
    open.push(socket);
    const onAbort = (): void => {
      socket.destroy();
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", reject);
    socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
      socket.off("error", reject);
      signal.removeEventListener("abort", onAbort);
      resolve(socket);
    });
  });
}

/** Asks the proxy to open a tunnel to `authority`; the socket is ready for TLS once this returns. */
async function openTunnel(proxy: URL, authority: string, signal: AbortSignal, open: Socket[]): Promise<Socket> {
  const socket = await openProxySocket(proxy, signal, open);
  const credentials =
    proxy.username === "" && proxy.password === ""
      ? ""
      : `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`;
  const head = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const fail = (e: Error): void => {
      socket.destroy();
      reject(e);
    };
    const onAbort = (): void => fail(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("the proxy closed the connection")));
    socket.on("data", function onData(chunk: Buffer) {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > PROXY_HEAD_LIMIT) fail(new Error("the proxy's reply is too long"));
        return;
      }
      socket.off("data", onData);
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      if (end + 4 !== buffered.length) fail(new Error("the proxy sent data before the tunnel was secured"));
      else resolve(buffered.slice(0, end));
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credentials}\r\n`);
  });
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (status === undefined || !status.startsWith("2")) {
    socket.destroy();
    if (status === "407")
      throw new WebFetchFailed(
        "The proxy asked for credentials Dovet doesn't have (407). Don't retry this URL.",
        false,
      );
    const retry = status?.startsWith("5") === true;
    throw new WebFetchFailed(
      `The proxy refused the connection${status === undefined ? "" : ` (${status})`}.${retry ? "" : " Don't retry this URL."}`,
      retry,
    );
  }
  return socket;
}

/**
 * Dovet's own CONNECT tunnel through the proxy, then the request over TLS on it: the proxy resolves and connects, and
 * no `NO_PROXY` rule of the runtime can send the request somewhere else (Bun's `fetch` applies its own and then
 * connects directly, whatever the caller chose). A name that resolves here only to unsafe addresses is still refused.
 */
export function proxiedTransport(
  proxyUrl: string,
  deps: { resolve?: Resolver; secure?: (socket: Socket, serverName: string | undefined) => Duplex } = {},
): WebTransport {
  const resolve = deps.resolve ?? systemResolver;
  return async ({ url, headers, signal }) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(host) !== 0;
    let found: string[] | undefined = literal ? [host] : undefined;
    if (found === undefined) {
      try {
        found = await resolve(host);
      } catch {
        found = undefined;
      }
    }
    if (found !== undefined && !found.some(isSafeIpAddress)) throw new WebFetchRefused(localHostText(url.hostname));
    let proxy: URL;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      throw new WebFetchFailed("The configured proxy isn't a valid URL. Don't retry this URL.", false);
    }
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:")
      throw new WebFetchFailed("The configured proxy must be an http:// or https:// URL. Don't retry this URL.", false);
    const open: Socket[] = [];
    const closeAll = (): void => {
      for (const s of open) s.destroy();
    };
    signal.addEventListener("abort", closeAll, { once: true });
    try {
      const raw = await openTunnel(proxy, `${url.hostname}:${url.port === "" ? "443" : url.port}`, signal, open);
      const serverName = literal ? undefined : host;
      const secured = deps.secure?.(raw, serverName) ?? tlsConnect({ socket: raw, servername: serverName });
      open.push(secured as Socket);
      if (secured instanceof TLSSocket)
        await new Promise<void>((ok, bad) => {
          secured.once("secureConnect", ok);
          secured.once("error", bad);
          secured.once("close", () => bad(new Error("the connection closed during the TLS handshake")));
        });
      const reply = readResponse(secured);
      secured.write(requestText(url, headers));
      return await reply;
    } catch (e) {
      closeAll();
      if (signal.aborted) throw signal.reason ?? e;
      if (e instanceof WebFetchFailed) throw e;
      throw describeFailure(url.hostname, e);
    }
  };
}

function noProxyMatches(url: URL, noProxy: string): boolean {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const port = url.port === "" ? "443" : url.port;
  return noProxy.split(/[\s,]+/).some((raw) => {
    const entry = raw.toLowerCase().replace(/\.+$/, "");
    if (entry === "*") return true;
    const colon = entry.lastIndexOf(":");
    const named = colon > 0 && !entry.includes("]") && entry.indexOf(":") === colon ? entry.slice(0, colon) : entry;
    if (named !== entry && entry.slice(colon + 1) !== port) return false;
    const bare = named.replace(/^\*?\./, "");
    return bare !== "" && (host === bare || host.endsWith(`.${bare}`));
  });
}

/**
 * The proxy a request goes through, or none (the pinned path). Every URL is https here, so only `HTTPS_PROXY` counts.
 * Dovet alone applies `NO_PROXY`, and a host either `NO_PROXY` or `no_proxy` names goes direct (and pinned).
 */
export function proxyFor(
  url: URL,
  env: Readonly<Record<string, string | undefined>>,
  setting: string | undefined,
): string | undefined {
  const proxy = setting ?? env.HTTPS_PROXY ?? env.https_proxy;
  if (proxy === undefined || proxy === "") return undefined;
  return [env.NO_PROXY, env.no_proxy].some((v) => v !== undefined && noProxyMatches(url, v)) ? undefined : proxy;
}
