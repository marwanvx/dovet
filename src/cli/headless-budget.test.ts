// Budgets in the headless run (receipts-budgets "Behavior"): stop before the request that would exceed, warn at 80%, the daily ledger.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fakePlatform, sequentialIds, tempProject } from "../../test/helpers/index.ts";
import { DailyLedger } from "../agent/index.ts";
import type { Os } from "../platform/index.ts";
import type { LoadedSettings, LoadInput } from "../store/index.ts";
import { readSession } from "../store/index.ts";
import { exitCodeFor } from "./headless-output.ts";
import { type HeadlessRunInput, runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(NOW);

/** 20,000 prompt and 3,000 completion tokens: $0.058 at the placeholder rates, so $0.10 fits one request, not two. */
const USAGE = { promptTokens: 20_000, completionTokens: 3000 };

function counting(finalText = "done") {
  let sent = 0;
  const adapter = {
    render: () => ({
      provider: "nvidia",
      package: "x",
      modelId: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [],
      providerOptions: {},
    }),
    stream: async function* () {
      sent += 1;
      yield {
        type: "done",
        stopReason: sent === 1 ? "tool_use" : "end_turn",
        stored: {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "x",
          packageVersion: "1",
          modelId: "m",
          parts:
            sent === 1
              ? [{ kind: "tool_call", id: "c1", name: "Glob", inputJson: JSON.stringify({ pattern: "*.nothing" }) }]
              : [{ kind: "text", text: finalText }],
          usage: USAGE,
          finishReason: sent === 1 ? "tool_calls" : "stop",
        },
      };
    },
  };
  return { adapter: adapter as never, sent: () => sent };
}

const project = (budget?: object) =>
  tempProject({
    ".dovet/settings.json": JSON.stringify({
      checkpoints: { enabled: false },
      ...(budget === undefined ? {} : { budget }),
    }),
  });

function run(dir: { root: string }, adapter: unknown, over: Partial<HeadlessRunInput> = {}) {
  const env = { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" };
  const settings = {
    settings: { provider: "nvidia", model: "test/model" },
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
      offline: false,
      noSessionPersistence: false,
      continued: false,
      repair: false,
      allowedTools: [],
      disallowedTools: [],
    },
    prompt: "go",
    clock: { now: () => NOW },
    ids: sequentialIds("B"),
    pid: 1,
    host: "h",
    platform: fakePlatform(),
    adapter: adapter as never,
    ...over,
  });
}

async function events(dir: { root: string }, sessionId: string) {
  const read = await readSession({
    data: join(dir.root, "data"),
    projectRoot: dir.root,
    os: testOs(),
    session: sessionId,
  });
  return read.events;
}

describe("budgets in a headless run", () => {
  // spec: AC-RCPT-03
  test("a $0.10 session budget stops the session before the request that would exceed it", async () => {
    const dir = await project();
    try {
      const model = counting();
      const out = await run(dir, model.adapter, {
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          budget: 0.1,
          allowedTools: [],
          disallowedTools: [],
        },
      });
      expect(model.sent()).toBe(1);
      expect(out.exit).toEqual({ kind: "budget" });
      expect(exitCodeFor(out.exit)).toBe(4);
      expect(out.result).toContain("Session budget $0.10 would be exceeded (spent $0.06, next request ≈ $0.06)");
      expect(out.cost).toBeLessThan(0.1);
      const log = await events(dir, out.sessionId);
      const limit = log.find((e) => e.type === "budget.event" && (e.data as { kind: string }).kind === "limit-reached");
      expect(limit?.data).toEqual({ kind: "limit-reached", scope: "session", spent: out.cost ?? 0, limit: 0.1 });
      const end = log.findLast((e) => e.type === "turn.end");
      expect(end?.data).toEqual({ reason: "budget" });
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-RCPT-03
  test("crossing 80% of a turn budget logs a warning and does not interrupt", async () => {
    const dir = await project({ turn: 0.072 });
    try {
      const model = counting();
      const out = await run(dir, model.adapter);
      expect(out.exit).toEqual({ kind: "budget" });
      const budget = (await events(dir, out.sessionId)).filter((e) => e.type === "budget.event").map((e) => e.data);
      expect(budget.map((d) => (d as { kind: string }).kind)).toEqual(["warn", "limit-reached"]);
      expect(budget[0]).toMatchObject({ scope: "turn", limit: 0.072 });
      expect(out.warnings.some((w) => w.includes("turn budget at 80%"))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-RCPT-03
  test("a token budget stops on the estimate of the next request", async () => {
    const dir = await project({ tokens: 30_000 });
    try {
      const model = counting();
      const out = await run(dir, model.adapter);
      expect(model.sent()).toBe(1);
      expect(out.exit).toEqual({ kind: "budget" });
      expect(out.result).toContain("Token budget 30,000 would be exceeded (spent 23,000");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-RCPT-05
  test("a crashed session's unreconciled reservation counts against the daily budget", async () => {
    const dir = await project({ daily: 0.1 });
    try {
      const crashed = new DailyLedger({ dir: join(dir.root, "data", "budget"), session: "DEAD", now: () => NOW });
      await crashed.reserve("lost", 0.09, null);
      const model = counting();
      const out = await run(dir, model.adapter);
      expect(model.sent()).toBe(0);
      expect(out.exit).toEqual({ kind: "budget" });
      expect(out.result).toContain("Daily budget $0.10 would be exceeded (spent $0.09");
      const log = await events(dir, out.sessionId);
      expect(log.find((e) => e.type === "budget.event")?.data).toMatchObject({ scope: "day", limit: 0.1 });
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-RCPT-04
  test("every request is reserved and then committed in the day's ledger, whatever the budget", async () => {
    const dir = await project();
    try {
      const model = counting();
      const out = await run(dir, model.adapter);
      expect(out.exit).toEqual({ kind: "ok" });
      const lines = (await readFile(join(dir.root, "data", "budget", `${DAY}.ledger`), "utf8")).trim().split("\n");
      expect(lines.map((l) => l.split(" ")[0])).toEqual(["reserve", "commit", "reserve", "commit"]);
      expect(lines[0]).toContain(`${out.sessionId}.1`);
      expect(lines[1]).toBe(`commit ${out.sessionId}.1 0.058000`);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-RCPT-04
  test("a request the guards stop after its reservation is released, and so is one whose stream fails", async () => {
    const dir = await project();
    try {
      const model = counting();
      const out = await run(dir, model.adapter, {
        args: {
          print: true,
          output: "text",
          offline: false,
          noSessionPersistence: false,
          continued: false,
          repair: false,
          maxRequests: 1,
          allowedTools: [],
          disallowedTools: [],
        },
      });
      expect(out.exit).toEqual({ kind: "guard" });
      const lines = (await readFile(join(dir.root, "data", "budget", `${DAY}.ledger`), "utf8")).trim().split("\n");
      expect(lines.map((l) => l.split(" ")[0])).toEqual(["reserve", "commit", "reserve", "release"]);
    } finally {
      await dir.dispose();
    }
    const failing = await project();
    try {
      const adapter = {
        render: () => ({
          provider: "nvidia",
          package: "x",
          modelId: "m",
          messages: [],
          tools: [],
          providerOptions: {},
        }),
        stream: async function* () {
          yield {
            type: "error",
            error: { kind: "invalid_request", retryable: false, message: "boom" },
            completed: null,
          };
        },
      };
      const out = await run(failing, adapter);
      expect(out.exit).toEqual({ kind: "error" });
      const lines = (await readFile(join(failing.root, "data", "budget", `${DAY}.ledger`), "utf8")).trim().split("\n");
      expect(lines.map((l) => l.split(" ")[0])).toEqual(["reserve", "release"]);
    } finally {
      await failing.dispose();
    }
  });

  // spec: AC-RCPT-03
  test("a day total at 80% of the daily budget warns when the request is reserved, in the log and in the output", async () => {
    const dir = await project({ daily: 1 });
    try {
      const seed = new DailyLedger({ dir: join(dir.root, "data", "budget"), session: "SEED", now: () => NOW });
      await seed.reserve("seed", 0.85, null);
      await seed.commit("seed", 0.85);
      const out = await run(dir, counting().adapter);
      expect(out.warnings.some((w) => w.includes("day budget at 80% (0.85 of 1)"))).toBe(true);
      const warn = (await events(dir, out.sessionId)).find((e) => e.type === "budget.event");
      expect(warn?.data).toEqual({ kind: "warn", scope: "day", spent: 0.85, limit: 1 });
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-RCPT-04
  test("two headless sessions racing for the rest of the daily budget dispatch exactly one request", async () => {
    const dir = await project({ daily: 0.1 });
    try {
      const seed = new DailyLedger({ dir: join(dir.root, "data", "budget"), session: "SEED", now: () => NOW });
      await seed.reserve("seed", 0.03, null);
      await seed.commit("seed", 0.03);
      const a = counting();
      const b = counting();
      const [oa, ob] = await Promise.all([
        run(dir, a.adapter, { ids: sequentialIds("A") }),
        run(dir, b.adapter, { ids: sequentialIds("Z") }),
      ]);
      expect(a.sent() + b.sent()).toBe(1);
      expect([oa.exit.kind, ob.exit.kind]).toEqual(["budget", "budget"]);
    } finally {
      await dir.dispose();
    }
  });
});
