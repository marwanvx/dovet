// WebSearch in the headless boot (tools §10 "Choosing", ADR-25): offered only when a backend exists, and its results taint the session.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  tempProject as baseTempProject,
  fakePlatform,
  scriptedModel,
  sequentialIds,
} from "../../test/helpers/index.ts";
import { createSdkAdapter } from "../ai/index.ts";
import type { Os } from "../platform/index.ts";
import type { LoadedSettings, LoadInput } from "../store/index.ts";
import { readSession } from "../store/index.ts";
import type { SecondaryResult } from "../tools/index.ts";
import { type HeadlessRunInput, runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");

type Env = Record<string, string | undefined>;

/** Checkpoints are tested in headless-checkpoints.test.ts; here they would start two real `git` processes per run (F49). */
const tempProject = (files: Record<string, string> = {}) =>
  baseTempProject({ ".dovet/settings.json": JSON.stringify({ checkpoints: { enabled: false } }), ...files });

function run(
  dir: { root: string },
  over: {
    env?: Env;
    websearch?: object;
    steps?: Parameters<typeof scriptedModel>[0];
    allowed?: string[];
    offline?: boolean;
  } & Partial<HeadlessRunInput>,
) {
  const env: Env = { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp", ...over.env };
  const { env: _e, websearch, steps, allowed, offline, ...rest } = over;
  const settings = {
    settings: { provider: "nvidia", model: "test/model", ...(websearch ? { websearch } : {}) },
    rules: { allow: [], ask: [], deny: [] },
    warnings: [],
    notices: [],
    files: [],
    untrusted: [],
  } as unknown as LoadedSettings;
  const loadInput: LoadInput = {
    dirs: { config: join(dir.root, "cfg") },
    home: join(dir.root, "home"),
    projectRoot: dir.root,
    env,
    trust: { project: true, local: true },
  };
  const model = scriptedModel(steps ?? [{ text: "done" }]);
  return runHeadless({
    dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
    projectRoot: dir.root,
    cwd: dir.root,
    os: testOs(),
    settings,
    env,
    loadInput,
    args: {
      print: true,
      output: "text",
      offline: offline ?? false,
      noSessionPersistence: false,
      continued: false,
      repair: false,
      allowedTools: allowed ?? [],
      disallowedTools: [],
    },
    prompt: "look it up",
    clock: { now: () => Date.UTC(2026, 9, 21) },
    ids: sequentialIds("W"),
    pid: 1,
    host: "h",
    platform: fakePlatform(),
    adapter: createSdkAdapter({
      endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
      model: () => model,
    }),
    ...rest,
  });
}

async function toolNames(dir: { root: string }, sessionId: string): Promise<string[]> {
  const read = await readSession({
    data: join(dir.root, "data"),
    projectRoot: dir.root,
    os: testOs(),
    session: sessionId,
  });
  const start = read.events.find((e) => e.type === "epoch.start");
  const header = start?.data as { toolsJson?: string } | undefined;
  return (JSON.parse(header?.toolsJson ?? "[]") as Array<{ name: string }>).map((t) => t.name);
}

async function systemText(dir: { root: string }, sessionId: string): Promise<string> {
  const read = await readSession({
    data: join(dir.root, "data"),
    projectRoot: dir.root,
    os: testOs(),
    session: sessionId,
  });
  const data = read.events.find((e) => e.type === "epoch.start")?.data as { systemText: string } | undefined;
  return data?.systemText ?? "";
}

describe("WebSearch in the headless boot", () => {
  // spec: AC-TOOLS-12
  test("with no backend the tool is absent; a connected key or a SearXNG URL offers it", async () => {
    const none = await tempProject({});
    const keyed = await tempProject({});
    const searx = await tempProject({});
    const off = await tempProject({});
    try {
      const a = await run(none, {});
      expect(await toolNames(none, a.sessionId)).not.toContain("WebSearch");
      expect(await toolNames(none, a.sessionId)).toContain("WebFetch");
      const b = await run(keyed, { env: { TAVILY_API_KEY: "tvly-FAKE" } });
      expect(await toolNames(keyed, b.sessionId)).toContain("WebSearch");
      expect(await systemText(keyed, b.sessionId)).toContain("Use WebSearch to check specifics");
      expect(await systemText(none, a.sessionId)).not.toContain("Use WebSearch to check specifics");
      const c = await run(searx, { websearch: { searxngUrl: "http://127.0.0.1:9" } });
      expect(await toolNames(searx, c.sessionId)).toContain("WebSearch");
      const d = await run(off, { env: { TAVILY_API_KEY: "tvly-FAKE" }, websearch: { backend: "off" } });
      expect(await toolNames(off, d.sessionId)).not.toContain("WebSearch");
    } finally {
      await Promise.all([none.dispose(), keyed.dispose(), searx.dispose(), off.dispose()]);
    }
  });

  // spec: AC-TOOLS-12
  test("a search runs through the session, taints it and names the backend; a key never reaches the result", async () => {
    const dir = await tempProject({});
    try {
      const seen: Array<{ url: string; key: string | null }> = [];
      const out = await run(dir, {
        env: { EXA_API_KEY: "exa-FAKE-KEY-0123456789" },
        allowed: ["WebSearch"],
        steps: [{ toolCall: { id: "s1", name: "WebSearch", input: { query: "bun 1.4" } } }, { text: "found it" }],
        searchFetch: (async (input: string | URL | Request, init?: RequestInit) => {
          seen.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key") });
          return new Response(
            JSON.stringify({ results: [{ title: "Bun 1.4", url: "https://bun.sh/blog", highlights: ["released"] }] }),
            { headers: { "Content-Type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      });
      expect(out.exit).toEqual({ kind: "ok" });
      expect(seen).toEqual([{ url: "https://api.exa.ai/search", key: "exa-FAKE-KEY-0123456789" }]);
      const read = await readSession({
        data: join(dir.root, "data"),
        projectRoot: dir.root,
        os: testOs(),
        session: out.sessionId,
      });
      const result = read.events.find((e) => e.type === "tool.result")?.data as { status: string; output: string };
      expect(result.status).toBe("ok");
      expect(result.output).toContain("1. Bun 1.4\n   https://bun.sh/blog\n   released");
      expect(result.output).toContain("Search backend: exa");
      const logged = read.events.find((e) => e.type === "tool.result")?.data as { search?: object };
      expect(logged.search).toEqual({ backend: "exa", calls: 1 });
      expect(JSON.stringify(read.events)).not.toContain("exa-FAKE-KEY-0123456789");
      const taint = read.events.find((e) => e.type === "taint.change")?.data as { source: string; tainted: boolean };
      expect(taint).toMatchObject({ source: "WebSearch: exa", tainted: true });
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TOOLS-12
  test("an endpoint with a search mechanism uses the provider backend through ctx.model", async () => {
    const dir = await tempProject({});
    try {
      const asked: string[] = [];
      const reply: SecondaryResult = {
        results: [{ title: "From the provider", url: "https://p.example/1", snippet: "s" }],
        usage: {},
        serverToolCalls: 1,
      };
      const out = await run(dir, {
        allowed: ["WebSearch"],
        steps: [{ toolCall: { id: "s1", name: "WebSearch", input: { query: "q" } } }, { text: "ok" }],
        searchComplete: async (req) => {
          asked.push(req.query);
          return reply;
        },
      });
      expect(asked).toEqual(["q"]);
      const read = await readSession({
        data: join(dir.root, "data"),
        projectRoot: dir.root,
        os: testOs(),
        session: out.sessionId,
      });
      const result = read.events.find((e) => e.type === "tool.result")?.data as { output: string };
      expect(result.output).toContain("1. From the provider");
      expect(result.output).toContain("Search backend: provider");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-19
  test("--offline never offers the tool, whatever is connected", async () => {
    const dir = await tempProject({});
    try {
      const out = await run(dir, {
        env: { EXA_API_KEY: "exa-FAKE" },
        offline: true,
        searchComplete: async () => ({ results: [], usage: {}, serverToolCalls: 0 }),
      });
      expect(await toolNames(dir, out.sessionId)).not.toContain("WebSearch");
    } finally {
      await dir.dispose();
    }
  });
});
