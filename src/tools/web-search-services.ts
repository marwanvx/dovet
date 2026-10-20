// The search services behind WebSearch (tools §10): one request builder and one response parser each, all giving the same hits.
import { z } from "zod";
import { stripHidden } from "./hidden.ts";
import type { SearchHit } from "./types.ts";

export type ServiceId = "exa" | "brave" | "tavily" | "searxng";

export const SERVICE_LABELS: Readonly<Record<ServiceId | "provider", string>> = {
  provider: "The provider",
  exa: "Exa",
  brave: "Brave",
  tavily: "Tavily",
  searxng: "SearXNG",
};

export const SERVICE_HOSTS: Readonly<Record<Exclude<ServiceId, "searxng">, string>> = {
  exa: "api.exa.ai",
  brave: "api.search.brave.com",
  tavily: "api.tavily.com",
};

export const MAX_RESULTS = 10;
export const MAX_SNIPPET = 300;
const MAX_TITLE = 200;
const MAX_URL = 2000;

/** The response did not have the shape the service documents. */
export class UnexpectedResponse extends Error {}

export type ServiceQuery = {
  query: string;
  allowed: string[];
  blocked: string[];
  key?: string | undefined;
  searxngUrl?: string | undefined;
};

export type ServiceRequest = { url: string; init: RequestInit };

/** Whether the service applies the domain lists itself; otherwise Dovet filters by host. */
export const FILTERS_NATIVELY: Readonly<Record<ServiceId, boolean>> = {
  exa: true,
  tavily: true,
  brave: false,
  searxng: false,
};

export function buildRequest(id: ServiceId, q: ServiceQuery): ServiceRequest {
  const json = (url: string, headers: Record<string, string>, body: unknown): ServiceRequest => ({
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
    },
  });
  if (id === "exa")
    return json(
      "https://api.exa.ai/search",
      { "x-api-key": q.key ?? "" },
      {
        query: q.query,
        numResults: MAX_RESULTS,
        ...(q.allowed.length > 0 ? { includeDomains: q.allowed } : {}),
        ...(q.blocked.length > 0 ? { excludeDomains: q.blocked } : {}),
        contents: { highlights: { maxCharacters: MAX_SNIPPET } },
      },
    );
  if (id === "tavily")
    return json(
      "https://api.tavily.com/search",
      { Authorization: `Bearer ${q.key ?? ""}` },
      {
        query: q.query,
        max_results: MAX_RESULTS,
        include_published_date: true,
        ...(q.allowed.length > 0 ? { include_domains: q.allowed } : {}),
        ...(q.blocked.length > 0 ? { exclude_domains: q.blocked } : {}),
      },
    );
  const get = (url: URL, headers: Record<string, string>): ServiceRequest => ({
    url: url.href,
    init: { method: "GET", headers: { Accept: "application/json", ...headers }, redirect: "error" },
  });
  if (id === "brave") {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", q.query);
    url.searchParams.set("count", String(q.allowed.length + q.blocked.length > 0 ? 20 : MAX_RESULTS));
    return get(url, { "X-Subscription-Token": q.key ?? "" });
  }
  const url = new URL(`${(q.searxngUrl ?? "").replace(/\/+$/, "")}/search`);
  url.searchParams.set("q", q.query);
  url.searchParams.set("format", "json");
  return get(url, {});
}

const Str = z.string().nullish();
const List = z.array(z.unknown());

const Exa = z.object({ results: List });
const ExaItem = z.object({
  title: Str,
  url: z.string(),
  publishedDate: Str,
  highlights: z.array(z.string()).nullish(),
  text: Str,
});
const Tavily = z.object({ results: List });
const TavilyItem = z.object({ title: Str, url: z.string(), content: Str, published_date: Str });
const Brave = z.object({ query: z.object({}).loose(), web: z.object({ results: List }).nullish() });
const BraveItem = z.object({
  title: Str,
  url: z.string(),
  description: Str,
  page_age: Str,
  age: Str,
});
const Searxng = z.object({ results: List });
const SearxngItem = z.object({ title: Str, url: z.string(), content: Str, publishedDate: Str });

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Control, bidirectional and invisible code points: turned into spaces so a page can't hide or reorder text. */
const INVISIBLE: ReadonlyArray<readonly [number, number]> = [
  [0x0, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
];

const spaceInvisible = (text: string): string =>
  Array.from(text, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return INVISIBLE.some(([from, to]) => cp >= from && cp <= to) ? " " : ch;
  }).join("");

function withoutTags(text: string): string {
  // One pass can join the brackets around a removed tag into a new one (`<<b>x>`): repeat until nothing changes.
  for (let current = text; ; ) {
    const next = current.replace(/<[^<>]*>/g, "");
    if (next === current) return next.replace(/<[^>]*$/, "");
    current = next;
  }
}

function clean(text: string | null | undefined, max: number): string {
  const decoded = (text ?? "")
    .slice(0, max * 8)
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (m, e: string) => {
      if (e.startsWith("#")) {
        const code = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  const plain = spaceInvisible(withoutTags(decoded)).replace(/\s+/g, " ").trim();
  const shown = stripHidden(plain).text;
  return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown;
}

function dateOf(value: string | null | undefined): string | undefined {
  const v = (value ?? "").trim();
  if (v === "") return undefined;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(v);
  return day ? day[0] : clean(v, 30);
}

function hitOf(
  title: string | null | undefined,
  url: string,
  snippet: string | null | undefined,
  date: string | null | undefined,
): SearchHit | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  parsed.username = "";
  parsed.password = "";
  if (parsed.href.length > MAX_URL) return undefined;
  const hit: SearchHit = { title: clean(title, MAX_TITLE) || parsed.hostname, url: parsed.href };
  const d = dateOf(date);
  if (d !== undefined) hit.date = d;
  const s = clean(snippet, MAX_SNIPPET);
  if (s !== "") hit.snippet = s;
  return hit;
}

/** A hit from the provider's secondary request, held to the same limits as a service's. */
export const sanitizeHit = (h: SearchHit): SearchHit | undefined => hitOf(h.title, h.url, h.snippet, h.date);

function items<T>(raw: unknown[], schema: z.ZodType<T>, map: (item: T) => SearchHit | undefined): SearchHit[] {
  const hits = raw.flatMap((r) => {
    const parsed = schema.safeParse(r);
    const hit = parsed.success ? map(parsed.data) : undefined;
    return hit === undefined ? [] : [hit];
  });
  if (raw.length > 0 && hits.length === 0) throw new UnexpectedResponse("none of the results had a title and a URL");
  return hits;
}

export function parseResponse(id: ServiceId, body: unknown): SearchHit[] {
  if (id === "exa") {
    const r = Exa.safeParse(body);
    if (!r.success) throw new UnexpectedResponse("no results list");
    return items(r.data.results, ExaItem, (i) =>
      hitOf(i.title, i.url, i.highlights?.join(" ") || (i.text ?? ""), i.publishedDate),
    );
  }
  if (id === "tavily") {
    const r = Tavily.safeParse(body);
    if (!r.success) throw new UnexpectedResponse("no results list");
    return items(r.data.results, TavilyItem, (i) => hitOf(i.title, i.url, i.content ?? "", i.published_date));
  }
  if (id === "brave") {
    const r = Brave.safeParse(body);
    if (!r.success) throw new UnexpectedResponse("no query or web results");
    return items(r.data.web?.results ?? [], BraveItem, (i) =>
      hitOf(i.title, i.url, i.description ?? "", i.page_age ?? i.age),
    );
  }
  const r = Searxng.safeParse(body);
  if (!r.success) throw new UnexpectedResponse("no results list");
  return items(r.data.results, SearxngItem, (i) => hitOf(i.title, i.url, i.content ?? "", i.publishedDate));
}

/** Lowercase host names from what a model writes: `https://Bun.sh/docs`, `*.bun.sh` and `bun.sh` all mean the same. */
export function normalizeDomains(domains: readonly string[] | undefined): string[] {
  return (domains ?? [])
    .map((d) => {
      const t = d.trim().toLowerCase();
      const host = t.includes("://") ? (URL.canParse(t) ? new URL(t).hostname : t) : (t.split("/")[0] ?? t);
      return host.replace(/^\*?\./, "").replace(/\.$/, "");
    })
    .filter((d) => d !== "");
}

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Applies the allow or block list to results by host; the second value is how many it removed. */
export function filterByHost(
  hits: SearchHit[],
  allowed: readonly string[],
  blocked: readonly string[],
): [SearchHit[], number] {
  if (allowed.length === 0 && blocked.length === 0) return [hits, 0];
  const kept = hits.filter((h) => {
    const host = new URL(h.url).hostname.toLowerCase();
    if (allowed.length > 0) return allowed.some((d) => hostMatches(host, d));
    return !blocked.some((d) => hostMatches(host, d));
  });
  return [kept, hits.length - kept.length];
}
