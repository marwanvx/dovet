import { describe, expect, test } from "bun:test";
import {
  claudeArgs,
  decide,
  describeEvent,
  type Feed,
  highRiskPaths,
  lastEntry,
  limitsLine,
  mergeCheck,
  modelFor,
  newFeed,
  parseArgs,
  parseRun,
  type RunResult,
  tierFor,
} from "./auto.ts";

const ok: RunResult = { isError: false, subtype: "success", result: "Shipped M1-12.", costUsd: 4.2, sessionId: "s1" };

describe("parseArgs", () => {
  test("defaults: 3 tasks, the model picked per task, a $10 cap per run", () => {
    expect(parseArgs([])).toEqual({ tasks: 3, budgetUsd: 10 });
  });

  test("reads the task count, --model and --budget", () => {
    expect(parseArgs(["5", "--model", "opus", "--budget", "8"])).toEqual({ tasks: 5, model: "opus", budgetUsd: 8 });
  });

  test("refuses nonsense", () => {
    expect(() => parseArgs(["0"])).toThrow(/task count/);
    expect(() => parseArgs(["--budget", "x"])).toThrow(/budget/);
    expect(() => parseArgs(["--wat"])).toThrow(/--wat/);
  });
});

describe("claudeArgs", () => {
  test("uses the flags the Claude Code docs recommend for unattended runs", () => {
    const args = claudeArgs({ tasks: 1, budgetUsd: 20 }, { model: "sonnet", effort: "medium" });
    expect(args.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(args[2]).toContain("Continue building Dovet.");
    expect(args[2]).toContain("unattended");
    expect(args[2]).toContain("reviewer agent");
    expect(args[2]).toContain("Context7");
    expect(args[2]).toContain("at most three rounds");
    expect(args[2]).toContain("Never set git config");
    expect(args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "auto",
        "--permission-prompts",
        "none",
        "--output-format",
        "stream-json",
        "--verbose",
      ]),
    );
    expect(args.join(" ")).toContain("--model sonnet");
    expect(args.join(" ")).toContain("--effort medium");
    expect(args.join(" ")).toContain("--max-budget-usd 20");
  });
});

describe("parseRun", () => {
  test("reads the JSON result of claude -p", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
      total_cost_usd: 0.0018,
      session_id: "73bf",
      num_turns: 1,
    });
    expect(parseRun(stdout)).toEqual({
      isError: false,
      subtype: "success",
      result: "OK",
      costUsd: 0.0018,
      sessionId: "73bf",
    });
  });

  test("output that isn't a result is reported, not guessed", () => {
    expect(parseRun("Error: not logged in")).toEqual({ unreadable: "Error: not logged in" });
  });
});

describe("lastEntry", () => {
  test("finds the newest progress entry", () => {
    const text =
      "# Progress\n\n## 2026-10-13 — M1-10 A\nNext: M1-11.\n\n## 2026-10-14 — M1-11 B\nDone: x.\nNext: M1-12.\n";
    expect(lastEntry(text)).toEqual({ count: 2, text: "## 2026-10-14 — M1-11 B\nDone: x.\nNext: M1-12." });
  });
});

describe("decide", () => {
  const entry = (next: string) => ({ count: 11, text: `## 2026-10-14 — M1-12 T\nDone: x.\nNext: ${next}` });

  test("a shipped task with a new progress entry goes on to the next", () => {
    expect(decide({ exitCode: 0, run: ok, before: 10, after: entry("M1-13.") })).toEqual({ action: "next" });
  });

  test("a session limit waits for the reset and retries; a weekly limit stops", () => {
    const limited = { ...ok, isError: true, result: "You've hit your session limit · resets 4pm" };
    expect(decide({ exitCode: 1, run: limited, before: 10, after: { count: 10, text: "" } }).action).toBe("wait");
    const weekly = { ...ok, isError: true, result: "You've hit your weekly limit · resets Mon" };
    expect(decide({ exitCode: 1, run: weekly, before: 10, after: { count: 10, text: "" } }).action).toBe("stop");
  });

  test("a failed run, a run that hit its budget, or one with no progress entry stops", () => {
    const failed = decide({
      exitCode: 1,
      run: { ...ok, isError: true, subtype: "error_during_execution" },
      before: 10,
      after: entry("M1-13."),
    });
    expect(failed.action).toBe("stop");
    const budget = decide({
      exitCode: 0,
      run: { ...ok, subtype: "error_max_budget_usd" },
      before: 10,
      after: entry("M1-13."),
    });
    expect(budget).toEqual({ action: "stop", reason: expect.stringMatching(/budget/) });
    const silent = decide({ exitCode: 0, run: ok, before: 10, after: { count: 10, text: "" } });
    expect(silent).toEqual({ action: "stop", reason: expect.stringMatching(/progress entry/) });
    expect(decide({ exitCode: 0, run: { unreadable: "boom" }, before: 10, after: entry("M1-13.") }).action).toBe(
      "stop",
    );
  });

  test("a task that waits for the owner or is blocked stops the run", () => {
    expect(decide({ exitCode: 0, run: ok, before: 10, after: entry("blocked on the release key.") }).action).toBe(
      "stop",
    );
    expect(decide({ exitCode: 0, run: ok, before: 10, after: entry("M2-01 (waiting for owner).") }).action).toBe(
      "stop",
    );
  });
});

describe("live feed", () => {
  const ROOT = "/home/u/dovet";
  const tool = (name: string, input: Record<string, unknown>, parent: string | null = null) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id: `id-${name}`, name, input }] },
  });
  const lines = (feed: Feed, ev: unknown) => describeEvent(ev, feed, ROOT);

  test("tool calls read as plain actions, with paths relative to the project", () => {
    const feed = newFeed();
    expect(lines(feed, tool("Read", { file_path: `${ROOT}/src/a.ts` }))).toEqual(["read   src/a.ts"]);
    expect(lines(feed, tool("Edit", { file_path: `${ROOT}/src/a.ts` }))).toEqual(["edit   src/a.ts"]);
    expect(lines(feed, tool("Bash", { command: "bun test src/agent\necho done" }))).toEqual([
      "run    bun test src/agent",
    ]);
    expect(lines(feed, tool("mcp__claude_ai_Context7__query-docs", { query: "zod" }))).toEqual([
      "docs   Context7 query-docs",
    ]);
    expect(lines(feed, tool("Grep", { pattern: "isWithin" }))).toEqual(['search "isWithin"']);
  });

  test("helper agents are named, and their own steps are marked with that name", () => {
    const feed = newFeed();
    expect(lines(feed, tool("Agent", { subagent_type: "reviewer", description: "Review M1-12" }))).toEqual([
      "agent  reviewer: Review M1-12",
    ]);
    expect(lines(feed, tool("Read", { file_path: `${ROOT}/x.ts` }, "id-Agent"))).toEqual(["  [reviewer] read   x.ts"]);
  });

  test("what Claude says is shown as one line; thinking is not", () => {
    const feed = newFeed();
    const say = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "Tests pass.\nShipping." },
        ],
      },
    };
    expect(lines(feed, say)).toEqual(["says   Tests pass."]);
  });

  test("a failed tool result is shown", () => {
    const feed = newFeed();
    lines(feed, tool("Bash", { command: "bun test" }));
    const result = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "id-Bash", is_error: true, content: "error: 2 tests failed\nmore" },
        ],
      },
    };
    expect(lines(feed, result)).toEqual(["  ✗ Bash failed: error: 2 tests failed"]);
  });

  test("usage limits are kept and shown as percentages", () => {
    const feed = newFeed();
    const ev = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        unifiedWindows: {
          five_hour: { utilization: 0.24, resetsAt: 1791945600 },
          seven_day: { utilization: 0.68, resetsAt: 1792400400 },
        },
      },
    };
    expect(lines(feed, ev)).toEqual([]);
    expect(limitsLine(feed)).toMatch(/^plan usage: 5-hour 24% \(resets .+\) · week 68% \(resets .+\)$/);
    expect(feed.fiveHourResetMs).toBe(1791945600 * 1000);
  });

  test("unknown events are ignored, not guessed at", () => {
    expect(lines(newFeed(), { type: "something_new" })).toEqual([]);
    expect(lines(newFeed(), "not an object")).toEqual([]);
  });
});

const review =
  "## High-risk paths\n\nA diff touching any of these gets the `deep` tier: `src/policy/**`, `src/cli/update.ts`, `docs/prompts/**`.\n";
const next = (followups: string, build: string) =>
  `## Follow-ups to fix first (build loop step 2.4)\n${followups}\n\n## Task M2-05 Workspace trust\n\n- **Build:** ${build}\n`;

describe("tierFor", () => {
  test("a task touching a high-risk path is deep, plain code standard, docs-only quick", () => {
    const risk = highRiskPaths(review);
    expect(risk).toEqual(["src/policy/", "src/cli/update.ts", "docs/prompts/"]);
    expect(tierFor(next("(none)", "the trust store in `src/policy/trust/` and `src/cli/main.ts`"), risk)).toBe("deep");
    expect(tierFor(next("(none)", "`src/tools/web-fetch.ts` and its tests"), risk)).toBe("standard");
    expect(tierFor(next("(none)", "nothing in `src/`. Re-run the audit scripts"), risk)).toBe("quick");
  });

  test("an open follow-up is the session's work, so its paths decide the tier", () => {
    const risk = highRiskPaths(review);
    const f = "### F2: usage\n- **Severity:** major · `src/cli/headless-run.ts:894`";
    expect(tierFor(next(f, "the trust store in `src/policy/trust/`"), risk)).toBe("standard");
  });
});

describe("modelFor", () => {
  test("Sonnet at high for quick and standard work, Opus at medium for deep work, an explicit --model wins", () => {
    expect(modelFor("quick")).toEqual({ model: "sonnet", effort: "high" });
    expect(modelFor("standard")).toEqual({ model: "sonnet", effort: "high" });
    expect(modelFor("deep")).toEqual({ model: "opus", effort: "medium" });
    expect(modelFor("quick", "opus")).toEqual({ model: "opus", effort: "high" });
  });
});

describe("mergeCheck", () => {
  test("a progress entry that says merged is checked against GitHub", () => {
    const entry = "## 2026-10-20 — M2-05 Workspace trust\nDone: x. PR: #160 (merged).\nNext: M2-06.";
    expect(mergeCheck(entry, () => "MERGED")).toBeUndefined();
    expect(mergeCheck(entry, () => "OPEN")).toEqual({
      action: "stop",
      reason: "the progress entry says PR #160 merged, but GitHub says it is OPEN",
    });
  });

  test("an entry that waits for the owner, or names no PR, isn't checked", () => {
    expect(mergeCheck("Done: x. PR: #161 (waiting for owner).", () => "OPEN")).toBeUndefined();
    expect(mergeCheck("Done: a docs fix.", () => "OPEN")).toBeUndefined();
  });
});
