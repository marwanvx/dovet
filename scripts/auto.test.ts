import { describe, expect, test } from "bun:test";
import { claudeArgs, decide, lastEntry, parseArgs, parseRun, type RunResult } from "./auto.ts";

const ok: RunResult = { isError: false, subtype: "success", result: "Shipped M1-12.", costUsd: 4.2, sessionId: "s1" };

describe("parseArgs", () => {
  test("defaults: 3 tasks, Sonnet builds, a $20 cap per run", () => {
    expect(parseArgs([])).toEqual({ tasks: 3, model: "sonnet", budgetUsd: 20 });
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
    const args = claudeArgs({ tasks: 1, model: "sonnet", budgetUsd: 20 });
    expect(args.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(args[2]).toContain("Continue building Dovet.");
    expect(args[2]).toContain("unattended");
    expect(args[2]).toContain("reviewer agent");
    expect(args[2]).toContain("Context7");
    expect(args).toEqual(
      expect.arrayContaining(["--permission-mode", "auto", "--permission-prompts", "none", "--output-format", "json"]),
    );
    expect(args.join(" ")).toContain("--model sonnet");
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
