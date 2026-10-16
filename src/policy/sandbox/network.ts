// Sandbox network helpers (permissions §7.4, §10): registry allowlist, local-address refusal, taint trigger.
import { isIP } from "node:net";

export const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "repo.maven.apache.org",
  "api.nuget.org",
];

const stripPort = (host: string): string => {
  const t = host.trim().toLowerCase().replace(/\.+$/, "");
  if (t.startsWith("[")) {
    const close = t.indexOf("]");
    if (close < 0) return t;
    return t.slice(1, close);
  }
  if ((t.match(/:/g) ?? []).length === 1) return t.split(":")[0] ?? t;
  return t;
};

const norm = (host: string): string => stripPort(host).toLowerCase().replace(/\.+$/, "");

/** Package registries are pre-allowed so installs don't prompt (permissions §7.4). */
export function isRegistryHost(host: string): boolean {
  const h = norm(host);
  return (DEFAULT_ALLOWED_DOMAINS as readonly string[]).some((r) => r.toLowerCase() === h);
}

/** `localhost` and names under `.localhost` (RFC 6761): always allowed, never a taint source. */
export function isLoopbackName(host: string): boolean {
  const h = norm(host);
  return h === "localhost" || h.endsWith(".localhost");
}

function ipv4Parts(addr: string): number[] | undefined {
  const parts = addr.split(".");
  if (parts.length !== 4) return undefined;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return undefined;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    nums.push(n);
  }
  return nums;
}

/** True for an IP literal that the resolved-address guard refuses (loopback, link-local). */
export function isLocalIpLiteral(host: string): boolean {
  const bare = stripPort(host);
  const clean = bare.replace(/%.*$/, "");
  const family = isIP(clean);
  if (family === 4) {
    const parts = ipv4Parts(clean);
    if (parts === undefined) return false;
    const [a = 0, b = 0] = parts;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (family === 6) {
    const lower = clean.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("::ffff:127.")) return true;
    if (lower.startsWith("::ffff:169.254.")) return true;
    return false;
  }
  return false;
}

/** Hostnames resolving only to local addresses are refused after resolution; an explicit IP:port allow lifts it. */
export function shouldRefuseLocalHost(host: string, allowedDomains?: readonly string[]): boolean {
  if (isLoopbackName(host)) return false;
  if (!isLocalIpLiteral(host)) return false;
  if (allowedDomains === undefined) return true;
  const want = host.trim().toLowerCase().replace(/\.+$/, "");
  const bareWant = stripPort(host).toLowerCase();
  for (const entry of allowedDomains) {
    const e = entry.trim().toLowerCase().replace(/\.+$/, "");
    if (e === want) return false;
    if (!e.includes(":") && stripPort(e).toLowerCase() === bareWant) return false;
  }
  return true;
}

/** Data from an arbitrary host is as untrusted as a fetched page: registry and loopback names never taint. */
export function hostNeedsTaint(host: string): boolean {
  if (isLoopbackName(host)) return false;
  return !isRegistryHost(host);
}

export type HostAskMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

/** Proxy ask callback (permissions §7.4): denied always refused; strict refusals never prompt. */
export function makeHostAsker(opts: {
  mode: HostAskMode | (() => HostAskMode);
  allowedDomains: readonly string[];
  deniedDomains: readonly string[];
  strictAllowlist: boolean;
  ask: (host: string) => Promise<boolean>;
}): (params: { host: string; port: number | undefined }) => Promise<boolean> {
  const allowed = new Set(opts.allowedDomains.map((h) => h.toLowerCase().replace(/\.+$/, "")));
  const denied = new Set(opts.deniedDomains.map((h) => h.toLowerCase().replace(/\.+$/, "")));
  return async ({ host, port }): Promise<boolean> => {
    const mode = typeof opts.mode === "function" ? opts.mode() : opts.mode;
    const h = host.toLowerCase().replace(/\.+$/, "");
    const withPort = port === undefined ? h : `${h}:${port}`;
    if ([...denied].some((d) => d === h || d === withPort)) return false;
    if (shouldRefuseLocalHost(port === undefined ? h : `${h}:${port}`, opts.allowedDomains)) return false;
    if ([...allowed].some((a) => a === h || a === withPort) || isRegistryHost(h) || isLoopbackName(h)) return true;
    if (opts.strictAllowlist) return false;
    if (mode === "dontAsk") return false;
    if (mode === "bypassPermissions") return true;
    return opts.ask(h);
  };
}

/** Hosts named by `https://host/` URLs in a shell command, for the proxy-log taint heuristic. */
export function extractHosts(command: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/([A-Za-z0-9.-]+|\[[^\]]+\])(?::\d+)?/g;
  for (const m of command.matchAll(re)) {
    const host = m[1];
    if (host !== undefined && !out.includes(host)) out.push(host.toLowerCase().replace(/\.+$/, ""));
  }
  return out;
}

/** The taint source for a sandboxed command that reached a non-registry host, if any. */
export function taintSourceForCommand(command: string): string | undefined {
  const host = extractHosts(command).find((h) => hostNeedsTaint(h));
  return host === undefined ? undefined : `sandbox: ${host}`;
}
