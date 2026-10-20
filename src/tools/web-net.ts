// WebFetch's network layer (tools §9): which hosts are refused, and the transports that reach the rest.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isSafeIpAddress } from "guarded-fetch";

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

/** Bun's own fetch, for a configured proxy: the proxy resolves and connects, so only the literal checks apply. */
export function proxiedTransport(proxy: string | undefined): WebTransport {
  return async ({ url, headers, signal }) => {
    try {
      return await fetch(url, { headers, signal, redirect: "manual", ...(proxy === undefined ? {} : { proxy }) });
    } catch (e) {
      if (signal.aborted) throw e;
      throw describeFailure(url.hostname, e);
    }
  };
}
