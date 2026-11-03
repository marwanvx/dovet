import { describe, expect, test } from "bun:test";
import {
  appEnv,
  claudeArgs,
  decide,
  type Ending,
  highRiskPaths,
  hookSettings,
  lastEntry,
  mergeCheck,
  modelFor,
  openRuns,
  parseArgs,
  sessionEnding,
  tierFor,
} from "./auto.ts";

const ok: Ending = { kind: "done", message: "Shipped M1-12." };

describe("parseArgs", () => {
  test("defaults: 3 tasks, the model picked per task", () => {
    expect(parseArgs([])).toEqual({ tasks: 3 });
  });

  test("reads the task count and --model", () => {
    expect(parseArgs(["5", "--model", "opus"])).toEqual({ tasks: 5, model: "opus" });
  });

  test("refuses nonsense, and says why --budget is gone", () => {
    expect(() => parseArgs(["0"])).toThrow(/task count/);
    expect(() => parseArgs(["--budget", "8"])).toThrow(/only works with claude -p/);
    expect(() => parseArgs(["--wat"])).toThrow(/--wat/);
  });
});

describe("claudeArgs", () => {
  test("opens the interactive app with the task prompt, a session id, a name and the hooks", () => {
    const args = claudeArgs(
      { model: "sonnet", effort: "medium" },
      { sessionId: "s-1", name: "task 1", settings: "{}" },
    );
    expect(args[0]).toBe("claude");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--max-budget-usd");
    expect(args[1]).toContain("Continue building Dovet.");
    expect(args[1]).toContain("unattended");
    expect(args[1]).toContain("reviewer agent");
    expect(args[1]).toContain("Context7");
    expect(args[1]).toContain("at most three rounds");
    expect(args[1]).toContain("Never set git config");
    const flags = args.slice(2).join(" ");
    expect(flags).toContain("--permission-mode auto");
    expect(flags).toContain("--model sonnet");
    expect(flags).toContain("--effort medium");
    expect(flags).toContain("--session-id s-1");
    expect(flags).toContain("--name task 1");
    expect(flags).toContain("--settings {}");
  });
});

describe("hookSettings", () => {
  test("Stop and StopFailure both append their input to the marker file through this script", () => {
    const settings = JSON.parse(hookSettings("/usr/bin/bun", "/repo dir/scripts/auto.ts", "/tmp/m.jsonl"));
    const command = '"/usr/bin/bun" "/repo dir/scripts/auto.ts" --hook "/tmp/m.jsonl"';
    for (const event of ["Stop", "StopFailure"]) {
      expect(settings.hooks[event]).toEqual([{ hooks: [{ type: "command", command }] }]);
    }
  });
});

describe("appEnv", () => {
  test("drops the variables a parent Claude Code session leaves behind, keeps the rest and adds the identity", () => {
    const env = appEnv(
      {
        PATH: "/bin",
        CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
        CLAUDE_CODE_SESSION_ID: "x",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_MESSAGING_SOCKET: "/s",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "9",
      },
      { GIT_AUTHOR_NAME: "Marwan" },
    );
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "9", GIT_AUTHOR_NAME: "Marwan" });
  });
});

describe("sessionEnding", () => {
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

  test("nothing yet, or a stop while background work is still running, means the session is still working", () => {
    expect(sessionEnding("")).toBeUndefined();
    const waiting = line({
      hook_event_name: "Stop",
      last_assistant_message: "waiting",
      background_tasks: [{ id: "a", status: "running" }],
      session_crons: [],
    });
    expect(sessionEnding(waiting)).toBeUndefined();
  });

  test("the newest stop with nothing in flight ends the session with Claude's last message", () => {
    const text =
      line({ hook_event_name: "Stop", last_assistant_message: "waiting", background_tasks: [{ status: "running" }] }) +
      line({
        hook_event_name: "Stop",
        last_assistant_message: "Shipped M2-07.",
        background_tasks: [],
        session_crons: [],
      });
    expect(sessionEnding(text)).toEqual({ kind: "done", message: "Shipped M2-07." });
  });

  test("a turn that ends on an API error is a failure with its error type", () => {
    const text = line({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      last_assistant_message: "You've hit your limit",
    });
    expect(sessionEnding(text)).toEqual({ kind: "failed", error: "rate_limit", message: "You've hit your limit" });
  });

  test("a line that isn't a hook event is skipped, not guessed at", () => {
    expect(sessionEnding("not json\n")).toBeUndefined();
  });
});

describe("lastEntry", () => {
  test("finds the newest progress entry", () => {
    const text =
      "# Progress\n\n## 2026-10-13 — M1-10 A\nNext: M1-11.\n\n## 2026-10-14 — M1-11 B\nDone: x.\nNext: M1-12.\n";
    expect(lastEntry(text)).toEqual({ count: 2, text: "## 2026-10-14 — M1-11 B\nDone: x.\nNext: M1-12." });
  });
});

describe("openRuns", () => {
  const e = (task: string, pr: string) => `## 2026-10-20 — ${task} T\nDone: x. PR: #1 (${pr}).\nNext: y.\n\n`;

  test("counts the newest entries in a row that left the same task's PR open", () => {
    const progress = `# Progress\n\n${e("M2-05", "merged")}${e("M2-05b", "open, not merged")}${e("M2-05b", "open")}`;
    expect(openRuns(progress)).toBe(2);
    expect(openRuns(`${e("M2-04", "open")}${e("M2-05", "open")}`)).toBe(1);
    expect(openRuns(`${e("M2-05b", "open")}${e("M2-05b", "merged")}`)).toBe(0);
  });
});

describe("decide", () => {
  const entry = (next: string) => ({ count: 11, text: `## 2026-10-14 — M1-12 T\nDone: x.\nNext: ${next}` });

  test("a shipped task with a new progress entry goes on to the next", () => {
    expect(decide({ ending: ok, before: 10, after: entry("M1-13.") })).toEqual({ action: "next" });
  });

  test("a session limit waits for the reset and retries; a weekly limit stops", () => {
    const limited: Ending = {
      kind: "failed",
      error: "rate_limit",
      message: "You've hit your session limit · resets 4pm",
    };
    expect(decide({ ending: limited, before: 10, after: { count: 10, text: "" } }).action).toBe("wait");
    const weekly: Ending = {
      kind: "failed",
      error: "rate_limit",
      message: "You've hit your weekly limit · resets Mon",
    };
    expect(decide({ ending: weekly, before: 10, after: { count: 10, text: "" } }).action).toBe("stop");
  });

  test("an API error, a closed app, or a session with no progress entry stops", () => {
    const failed = decide({
      ending: { kind: "failed", error: "server_error", message: "API Error: 500" },
      before: 10,
      after: entry("M1-13."),
    });
    expect(failed).toEqual({
      action: "stop",
      reason: "the session ended on an API error (server_error): API Error: 500",
    });
    const closed = decide({ ending: { kind: "closed" }, before: 10, after: entry("M1-13.") });
    expect(closed).toEqual({ action: "stop", reason: expect.stringMatching(/app was closed/) });
    const silent = decide({ ending: ok, before: 10, after: { count: 10, text: "" } });
    expect(silent).toEqual({ action: "stop", reason: expect.stringMatching(/progress entry/) });
  });

  test("a task left with its PR open after review goes on, so the next session can rethink it", () => {
    const open = { count: 11, text: "## 2026-10-20 — M2-05b T\nDone: x. PR: #164 (open, not merged).\nNext: rethink." };
    expect(decide({ ending: ok, before: 10, after: open, openRuns: 1 })).toEqual({ action: "next" });
    expect(decide({ ending: ok, before: 10, after: open, openRuns: 3 })).toEqual({
      action: "stop",
      reason: "M2-05b is still not merged after 3 sessions",
    });
  });

  test("a task that waits for the owner or is blocked stops the run", () => {
    expect(decide({ ending: ok, before: 10, after: entry("blocked on the release key.") }).action).toBe("stop");
    expect(decide({ ending: ok, before: 10, after: entry("M2-01 (waiting for owner).") }).action).toBe("stop");
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

  test("only the first follow-up decides, so a high-risk one further down the list does not make the session deep", () => {
    const risk = highRiskPaths(review);
    const store = "### F36: tail\n- **Severity:** major · `src/store/event-log/reader.ts:128`";
    const policy = "### F85: word\n- **Severity:** blocker · `src/policy/shell-parse/bash.ts`";
    expect(tierFor(next(`${store}\n\n${policy}`, "x"), risk)).toBe("standard");
    expect(tierFor(next(`${policy}\n\n${store}`, "x"), risk)).toBe("deep");
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
