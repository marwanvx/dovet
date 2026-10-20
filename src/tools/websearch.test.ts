import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "../schema/index.ts";
import { Secret } from "../store/index.ts";
import { createToolRegistry, type SecondaryRequest, type SecondaryResult, type ToolContext } from "./index.ts";
import { context, text, workspace } from "./test-context.ts";
import { SearchMechanismRejected, type ToolOutput } from "./types.ts";
import { chooseSearchBackend, createWebSearchTool, type WebSearchOptions } from "./websearch.ts";

const KEY = "sk-test-FAKE-search-key-1234567890";

type Call = { url: URL; init: RequestInit };
type Reply = Response | ((call: Call) => Response | Promise<Response>);

/** Stands in for the search APIs: records every request and answers with the scripted reply. */
function scripted(reply: Reply) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(input instanceof Request ? input.url : String(input)), init: init ?? {} };
    calls.push(call);
    return typeof reply === "function" ? reply(call) : reply.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const sent = (c: Call | undefined): Record<string, string> => (c?.init.headers ?? {}) as Record<string, string>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function rig(opts: Partial<WebSearchOptions> & Pick<WebSearchOptions, "backend">, settings: object = {}) {
  const dir = await workspace();
  const tool = createWebSearchTool({ keys: {}, ...opts });
  const ctx = context(dir, { settings: Settings.parse(settings) });
  const run = (input: Record<string, unknown>, c: ToolContext = ctx): Promise<ToolOutput> => {
    const prep = createToolRegistry([tool as never]).prepare("WebSearch", input);
    if (!prep.ok) throw new Error(prep.message);
    return tool.run(prep.input as never, c);
  };
  return { tool, ctx, run, dir };
}

function model(
  id: string,
  reply: (req: SecondaryRequest) => SecondaryResult | Promise<SecondaryResult>,
): NonNullable<ToolContext["model"]> & { requests: SecondaryRequest[] } {
  const requests: SecondaryRequest[] = [];
  return {
    id,
    requests,
    async complete(req) {
      requests.push(req);
      return reply(req);
    },
  };
}

const hit = (n: number) => ({
  title: `Result ${n}`,
  url: `https://example.com/page-${n}`,
  snippet: `Snippet ${n}`,
});
const result = (n: number, over: Partial<SecondaryResult> = {}): SecondaryResult => ({
  results: Array.from({ length: n }, (_, i) => hit(i + 1)),
  usage: {},
  serverToolCalls: 1,
  ...over,
});

describe("choosing the backend", () => {
  const none = { setting: "auto", providerSearch: false, connected: [] } as const;

  // spec: AC-TOOLS-12
  test("with no backend the tool is not offered and the text says how to enable it", () => {
    expect(chooseSearchBackend(none)).toEqual({
      ok: false,
      text: "Connect a search service with /login, or set websearch.searxngUrl.",
    });
  });

  // spec: AC-TOOLS-12
  test("auto prefers the provider, then the first connected service, then SearXNG", () => {
    expect(chooseSearchBackend({ ...none, providerSearch: true, connected: ["exa"] })).toEqual({
      ok: true,
      backend: "provider",
      fallback: "exa",
    });
    expect(chooseSearchBackend({ ...none, connected: ["tavily", "brave"] })).toEqual({ ok: true, backend: "tavily" });
    expect(chooseSearchBackend({ ...none, searxngUrl: "http://localhost:8080" })).toEqual({
      ok: true,
      backend: "searxng",
    });
    expect(chooseSearchBackend({ ...none, providerSearch: true, searxngUrl: "http://localhost:8080" })).toEqual({
      ok: true,
      backend: "provider",
      fallback: "searxng",
    });
  });

  // spec: AC-TOOLS-12
  test("an explicit backend is used or the tool is not offered; it never switches", () => {
    const base = { ...none, providerSearch: true, connected: ["exa"] } as const;
    expect(chooseSearchBackend({ ...base, setting: "brave" })).toEqual({
      ok: false,
      text: "websearch.backend is brave, but no brave key is connected. Connect it with /login.",
    });
    expect(chooseSearchBackend({ ...base, setting: "exa" })).toEqual({ ok: true, backend: "exa" });
    expect(chooseSearchBackend({ ...none, setting: "provider" })).toEqual({
      ok: false,
      text: "websearch.backend is provider, but this model's endpoint has no search mechanism.",
    });
    expect(chooseSearchBackend({ ...none, setting: "searxng" })).toEqual({
      ok: false,
      text: "websearch.backend is searxng, but websearch.searxngUrl is not set.",
    });
    const off = chooseSearchBackend({ ...base, setting: "off" });
    expect(off).toEqual({ ok: false, text: "WebSearch is turned off (websearch.backend: off)." });
  });
});

describe("the provider backend", () => {
  // spec: AC-TOOLS-12
  test("a secondary request returns numbered results, taint and a receipt naming the backend", async () => {
    const dir = await workspace();
    const tool = createWebSearchTool({ backend: "provider", keys: {} });
    const m = model("anthropic/claude-example", () =>
      result(2, {
        results: [
          { title: "Bun 1.4 released", url: "https://bun.sh/blog/1.4", date: "2026-09-30", snippet: "x".repeat(400) },
          { title: "Docs", url: "https://bun.sh/docs" },
        ],
      }),
    );
    const out = await tool.run({ query: "bun 1.4 release", allowed_domains: ["bun.sh"] }, context(dir, { model: m }));
    expect(m.requests).toEqual([{ purpose: "websearch", query: "bun 1.4 release", allowedDomains: ["bun.sh"] }]);
    expect(out.status).toBe("ok");
    const t = text(out);
    expect(t).toContain(`1. Bun 1.4 released\n   https://bun.sh/blog/1.4\n   2026-09-30\n   ${"x".repeat(299)}…`);
    expect(t).not.toContain("x".repeat(301));
    expect(t).toContain("2. Docs\n   https://bun.sh/docs\n");
    expect(t).toContain("Search backend: provider");
    expect(out.meta?.search).toEqual({ backend: "provider", calls: 1 });
    expect(out.meta?.effects).toEqual([{ kind: "taint", source: "WebSearch: provider" }]);
  });

  // spec: AC-TOOLS-12
  test("no secondary model on the context is an error naming the backend", async () => {
    const { run } = await rig({ backend: "provider" });
    const out = await run({ query: "anything" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("provider");
  });

  // spec: AC-TOOLS-44
  test("a dropped stream keeps the results that arrived and says so", async () => {
    const { run, ctx } = await rig({ backend: "provider" });
    const m = model("p/m", () => result(3, { dropped: "the connection was reset" }));
    const out = await run({ query: "q" }, { ...ctx, model: m });
    expect(out.status).toBe("ok");
    const t = text(out);
    expect(t).toContain("3. Result 3");
    expect(t).toContain("The search stream dropped (the connection was reset); these are the results that arrived.");
  });

  // spec: AC-TOOLS-44
  test("a dropped stream with nothing received is an error, not an empty list", async () => {
    const { run, ctx } = await rig({ backend: "provider" });
    const m = model("p/m", () => result(0, { dropped: "the connection was reset" }));
    const out = await run({ query: "q" }, { ...ctx, model: m });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("provider");
    expect(text(out)).toContain("the connection was reset");
  });

  // spec: AC-TOOLS-44
  test("a model whose API rejects the search tool falls back to the search service for the rest of the session", async () => {
    const s = scripted(json({ results: [{ title: "From Exa", url: "https://exa.example/a", highlights: ["hi"] }] }));
    const { run, ctx } = await rig({
      backend: "provider",
      auto: true,
      fallback: "exa",
      keys: { exa: new Secret(KEY) },
      fetch: s.fetchFn,
    });
    let asked = 0;
    const m = model("p/unknown-model", () => {
      asked++;
      throw new SearchMechanismRejected("web_search is not supported for this model");
    });
    const first = await run({ query: "one" }, { ...ctx, model: m });
    expect(first.status).toBe("ok");
    expect(text(first)).toContain("From Exa");
    expect(text(first)).toContain("provider search was rejected for p/unknown-model");
    expect(first.meta?.search?.backend).toBe("exa");
    const second = await run({ query: "two" }, { ...ctx, model: m });
    expect(second.status).toBe("ok");
    expect(text(second)).toContain("Search backend: exa");
    expect(asked).toBe(1);
    expect(s.calls).toHaveLength(2);
  });

  // spec: AC-TOOLS-44
  test("a rejected mechanism with no search service is an error, and an explicit provider never falls back", async () => {
    const reject = () => {
      throw new SearchMechanismRejected("not supported");
    };
    const auto = await rig({ backend: "provider", auto: true });
    const a = await auto.run({ query: "q" }, { ...auto.ctx, model: model("p/m", reject) });
    expect(a.status).toBe("error");
    expect(text(a)).toContain("Connect a search service with /login, or set websearch.searxngUrl");

    const s = scripted(json({ results: [] }));
    const explicit = await rig({
      backend: "provider",
      keys: { exa: new Secret(KEY) },
      fetch: s.fetchFn,
    });
    const e = await explicit.run({ query: "q" }, { ...explicit.ctx, model: model("p/m", reject) });
    expect(e.status).toBe("error");
    expect(s.calls).toHaveLength(0);
  });

  // spec: AC-TOOLS-44
  test("another failure of the provider backend is an error naming it", async () => {
    const { run, ctx } = await rig({ backend: "provider" });
    const m = model("p/m", () => {
      throw new Error("503 overloaded");
    });
    const out = await run({ query: "q" }, { ...ctx, model: m });
    expect(out.status).toBe("error");
    expect(text(out)).toBe("WebSearch failed (provider): 503 overloaded");
  });
});

describe("search services", () => {
  // spec: AC-TOOLS-12
  test("Exa: key header, native domain filters, highlights as the snippet", async () => {
    const s = scripted(
      json({
        results: [
          {
            title: "Exa one",
            url: "https://a.example/1",
            publishedDate: "2026-05-01",
            highlights: ["first", "second"],
          },
          { title: "Exa two", url: "https://a.example/2", publishedDate: null, text: "body text" },
        ],
      }),
    );
    const { run } = await rig({ backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn });
    const out = await run({ query: "hello", allowed_domains: ["a.example"] });
    const call = s.calls[0];
    expect(call?.url.href).toBe("https://api.exa.ai/search");
    expect(call?.init.method).toBe("POST");
    expect(sent(call)["x-api-key"]).toBe(KEY);
    expect(call?.init.redirect).toBe("error");
    const body = JSON.parse(String(call?.init.body));
    expect(body.query).toBe("hello");
    expect(body.includeDomains).toEqual(["a.example"]);
    expect(body.excludeDomains).toBeUndefined();
    expect(body.numResults).toBe(10);
    const t = text(out);
    expect(t).toContain("1. Exa one\n   https://a.example/1\n   2026-05-01\n   first second");
    expect(t).toContain("2. Exa two\n   https://a.example/2\n   body text");
    expect(t).toContain("Search backend: exa");
    expect(t).not.toContain("filtered");
    expect(t).not.toContain(KEY);
  });

  // spec: AC-TOOLS-12
  test("Tavily: bearer key, native domain filters, content as the snippet", async () => {
    const s = scripted(
      json({
        results: [{ title: "T", url: "https://t.example/x", content: "tavily snippet", published_date: "2026-01-02" }],
      }),
    );
    const { run } = await rig({ backend: "tavily", keys: { tavily: new Secret(KEY) }, fetch: s.fetchFn });
    const out = await run({ query: "q", blocked_domains: ["spam.example"] });
    const call = s.calls[0];
    expect(call?.url.href).toBe("https://api.tavily.com/search");
    expect(sent(call).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(call?.init.body));
    expect(body.exclude_domains).toEqual(["spam.example"]);
    expect(body.include_published_date).toBe(true);
    expect(text(out)).toContain("1. T\n   https://t.example/x\n   2026-01-02\n   tavily snippet");
  });

  // spec: AC-TOOLS-12
  test("Brave: subscription token, and Dovet filters by host and says so", async () => {
    const s = scripted(
      json({
        query: { original: "bun docs" },
        web: {
          results: [
            {
              title: "keep",
              url: "https://docs.bun.sh/a",
              description: "<strong>bold</strong> text",
              page_age: "2026-03-04T00:00:00",
            },
            { title: "drop", url: "https://other.example/b", description: "no" },
            { title: "also drop", url: "https://notbun.sh/c", description: "no" },
          ],
        },
      }),
    );
    const { run } = await rig({ backend: "brave", keys: { brave: new Secret(KEY) }, fetch: s.fetchFn });
    const out = await run({ query: "bun docs", allowed_domains: ["bun.sh"] });
    const call = s.calls[0];
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(call?.url.searchParams.get("q")).toBe("bun docs");
    expect(sent(call)["X-Subscription-Token"]).toBe(KEY);
    const t = text(out);
    expect(t).toContain("1. keep\n   https://docs.bun.sh/a\n   2026-03-04\n   bold text");
    expect(t).not.toContain("other.example");
    expect(t).not.toContain("notbun.sh");
    expect(t).toContain("Brave can't filter by domain, so Dovet removed 2 results from other hosts.");
  });

  // spec: AC-TOOLS-12
  test("on an Ollama-style session with a SearXNG URL, results come from SearXNG and the receipt says so", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${url.pathname}?${url.searchParams.toString()}`);
        if (url.pathname.startsWith("/moved"))
          return new Response(null, { status: 302, headers: { Location: "/search" } });
        return json({
          results: [
            {
              title: "Searx hit",
              url: "https://s.example/1",
              content: "searx snippet",
              publishedDate: "2026-02-03T10:00:00",
            },
            { title: "Not http", url: "javascript:alert(1)", content: "bad" },
          ],
        });
      },
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const { run } = await rig({ backend: "searxng" }, { websearch: { searxngUrl: base } });
    const out = await run({ query: "where is it" });
    expect(seen).toEqual(["/search?q=where+is+it&format=json"]);
    const t = text(out);
    expect(t).toContain("1. Searx hit\n   https://s.example/1\n   2026-02-03\n   searx snippet");
    expect(t).not.toContain("javascript:");
    expect(t).toContain("Search backend: searxng");
    expect(out.meta?.search?.backend).toBe("searxng");
    expect(out.meta?.effects).toEqual([{ kind: "taint", source: "WebSearch: searxng" }]);

    const moved = await rig({ backend: "searxng" }, { websearch: { searxngUrl: `${base}/moved/` } });
    const bad = await moved.run({ query: "q" });
    expect(bad.status).toBe("error");
    expect(text(bad)).toContain("WebSearch failed (searxng)");
  });

  // spec: AC-TOOLS-12
  test("results are capped at 10, snippets at 300 characters, and hidden characters are removed", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      title: i === 0 ? "Hidden\u{E0041}\u{E0042} title" : `T${i}`,
      url: `https://m.example/${i}`,
      content: "y".repeat(500),
    }));
    const s = scripted(json({ results: many }));
    const { run } = await rig({ backend: "tavily", keys: { tavily: new Secret(KEY) }, fetch: s.fetchFn });
    const t = text(await run({ query: "q" }));
    expect(t).toContain("10. T9");
    expect(t).not.toContain("11. ");
    expect(t).toContain("⟨2 hidden characters removed⟩");
    expect(t).not.toMatch(/y{301}/);
  });

  // spec: AC-TOOLS-44
  test("a backend failure is an error naming the backend, never an empty list and never the key", async () => {
    const cases: Array<[string, Reply, string]> = [
      ["401", json({ error: `bad key ${KEY}` }, 401), "HTTP 401"],
      ["429", new Response("slow down", { status: 429, headers: { "Retry-After": "30" } }), "HTTP 429"],
      ["500", new Response("boom", { status: 500 }), "HTTP 500"],
      ["not json", new Response("<html>oops</html>", { status: 200 }), "not valid JSON"],
      ["wrong shape", json({ unexpected: true }), "unexpected response"],
    ];
    for (const [name, reply, expected] of cases) {
      const s = scripted(reply);
      const { run } = await rig({ backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn });
      const out = await run({ query: "q" });
      expect(out.status, name).toBe("error");
      const t = text(out);
      expect(t, name).toContain("WebSearch failed (exa)");
      expect(t, name).toContain(expected);
      expect(t, name).not.toContain(KEY);
      expect(t, name).not.toContain("0 results");
    }
    const down = scripted(() => {
      throw new TypeError(`fetch failed for https://api.exa.ai/search with ${KEY}`);
    });
    const net = await rig({ backend: "exa", keys: { exa: new Secret(KEY) }, fetch: down.fetchFn });
    const out = await net.run({ query: "q" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("WebSearch failed (exa)");
    expect(text(out)).not.toContain(KEY);
  });

  // spec: AC-TOOLS-44
  test("a real empty result is said plainly, with the backend", async () => {
    const s = scripted(json({ results: [] }));
    const { run } = await rig({ backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn });
    const out = await run({ query: "zzzz" });
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("exa returned no results for this query.");
  });

  // spec: AC-TOOLS-44
  test("the user stopping the search is an interruption", async () => {
    const ac = new AbortController();
    const s = scripted(() => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const { run, ctx } = await rig({ backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn });
    const out = await run({ query: "q" }, { ...ctx, signal: ac.signal });
    expect(out.status).toBe("interrupted");
  });

  // spec: AC-TOOLS-44
  test("the search service price is counted only when the user sets one", async () => {
    const s = scripted(json({ results: [hit(1)] }));
    const priced = await rig(
      { backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn },
      { websearch: { pricePerSearch: 0.007 } },
    );
    expect((await priced.run({ query: "q" })).meta?.search).toEqual({ backend: "exa", calls: 1, priceUsd: 0.007 });
    const free = await rig({ backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn });
    expect((await free.run({ query: "q" })).meta?.search).toEqual({ backend: "exa", calls: 1 });
  });
});

describe("limits", () => {
  // spec: AC-TOOLS-44
  test("the 101st search within an hour is refused with the refill time", async () => {
    let clock = Date.UTC(2026, 9, 21, 12, 0, 0);
    const s = scripted(() => json({ results: [hit(1)] }));
    const { run } = await rig({
      backend: "exa",
      keys: { exa: new Secret(KEY) },
      fetch: s.fetchFn,
      now: () => clock,
    });
    for (let i = 0; i < 100; i++) {
      const ok = await run({ query: `q${i}` });
      expect(ok.status, `search ${i + 1}`).toBe("ok");
      clock += 1000;
    }
    const refused = await run({ query: "one too many" });
    expect(refused.status).toBe("error");
    expect(s.calls).toHaveLength(100);
    expect(text(refused)).toBe(
      "WebSearch budget used up: 100 searches in the last hour (websearch.perHour). The next one is available at 13:00:00 UTC, in 59 min.",
    );
    clock = Date.UTC(2026, 9, 21, 13, 0, 0);
    expect((await run({ query: "after the refill" })).status).toBe("ok");
    expect(s.calls).toHaveLength(101);
  });

  // spec: AC-TOOLS-44
  test("websearch.perHour sets the budget, 0 means unlimited, and the rest is reported", async () => {
    const s = scripted(() => json({ results: [hit(1)] }));
    const small = await rig(
      { backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn },
      { websearch: { perHour: 2 } },
    );
    expect(text(await small.run({ query: "a" }))).toContain("1 of 2 searches left this hour");
    expect((await small.run({ query: "b" })).status).toBe("ok");
    expect((await small.run({ query: "c" })).status).toBe("error");

    const unlimited = await rig(
      { backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn },
      { websearch: { perHour: 0 } },
    );
    for (let i = 0; i < 120; i++) expect((await unlimited.run({ query: `q${i}` })).status).toBe("ok");
    expect(unlimited.tool.remaining(unlimited.ctx.settings)).toBeNull();
    expect(small.tool.remaining(small.ctx.settings)).toBe(0);
  });

  // spec: AC-TOOLS-44
  test("a refused call makes no request, and both domain lists together are refused before any request", async () => {
    const s = scripted(() => json({ results: [hit(1)] }));
    const { run } = await rig({ backend: "exa", keys: { exa: new Secret(KEY) }, fetch: s.fetchFn });
    const out = await run({ query: "q", allowed_domains: ["a.example"], blocked_domains: ["b.example"] });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("allowed_domains and blocked_domains can't be combined");
    expect(s.calls).toHaveLength(0);
  });
});

describe("permission", () => {
  // spec: AC-TOOLS-12
  test("describeAction is a network action on the backend's host, and Manual mode prompts", async () => {
    const exa = await rig({ backend: "exa", keys: { exa: new Secret(KEY) } });
    const action = exa.tool.describeAction({ query: "q" }, exa.ctx);
    expect(action).toMatchObject({ kind: "network", host: "api.exa.ai", via: "websearch" });
    const searx = await rig({ backend: "searxng" }, { websearch: { searxngUrl: "http://localhost:8080" } });
    expect(searx.tool.describeAction({ query: "q" }, searx.ctx)).toMatchObject({ host: "searxng" });
    const provider = await rig({ backend: "provider" });
    expect(provider.tool.describeAction({ query: "q" }, provider.ctx)).toMatchObject({ host: "provider" });
  });
});

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});
