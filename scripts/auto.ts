// Build Dovet unattended: one fresh `claude -p` session per task, as the Claude Code docs recommend.
//
//     bun run auto                    # 3 tasks, model and effort picked per task from its risk tier, $10 cap per run
//     bun run auto 5 --model opus --budget 15
//
// The terminal shows each step as it happens (files read and edited, commands, helper agents, plan usage).
// Ctrl+C once: stop after the current task. Twice: stop now.
// It stops when a run fails, records no progress entry, leaves a task waiting for the owner, or leaves one task's
// PR open three sessions in a row (a PR left open after review goes on: the next session rethinks it). A 5-hour usage
// limit waits for the reset and retries; a weekly limit stops. Each run is logged to auto-runs.log.
import { appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

const ROOT = join(import.meta.dir, "..");
const LOG = join(ROOT, "auto-runs.log");
const LIMIT_WAIT_MS = 30 * 60 * 1000;
// Commits must never carry the owner's personal email: the repository is public.
const IDENTITY = {
  GIT_AUTHOR_NAME: "Marwan",
  GIT_COMMITTER_NAME: "Marwan",
  GIT_AUTHOR_EMAIL: "154838093+marwanvx@users.noreply.github.com",
  GIT_COMMITTER_EMAIL: "154838093+marwanvx@users.noreply.github.com",
};
const MAX_LIMIT_WAITS = 12;

export type Options = { tasks: number; model?: string; budgetUsd: number };
export type Tier = "quick" | "standard" | "deep";
export type Pick = { model: string; effort: string };
export type RunResult = { isError: boolean; subtype: string; result: string; costUsd: number; sessionId: string };
export type Decision = { action: "next" } | { action: "wait" | "stop"; reason: string };

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { tasks: 3, budgetUsd: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--model") opts.model = argv[++i] ?? "";
    else if (arg === "--budget") {
      opts.budgetUsd = Number(argv[++i]);
      if (!(opts.budgetUsd > 0)) throw new Error("--budget needs a dollar amount above 0");
    } else if (/^\d+$/.test(arg) && Number(arg) > 0) opts.tasks = Number(arg);
    else if (/^\d+$/.test(arg)) throw new Error("the task count must be at least 1");
    else throw new Error(`unknown argument ${arg}`);
  }
  if (opts.model === "") throw new Error("--model needs a model name");
  return opts;
}

const PROMPT = [
  "Continue building Dovet.",
  "This run is unattended: nobody can answer questions or approve prompts.",
  "Follow AGENTS.md and docs/workflow/build-loop.md for exactly one task: build it, review it, ship it, write the progress entry, then stop.",
  "Use the reviewer agent for step 7 (the security-reviewer agent for the deep tier's security lens) and the plan-checker agent for step 4 when the build loop calls for them; the owner asks for both. Pick the review tier from the diff and follow step 7's rounds rule: confirm each finding before fixing it, log pre-existing ones to FOLLOWUPS.md, later rounds review only the new diff, at most three rounds.",
  "Never set git config user.name or user.email; the environment already carries the commit identity.",
  "Check library APIs with the installed types, Context7 or DeepWiki, never from memory.",
  "If the next step needs the owner, write that in the progress entry's Next line and stop.",
].join(" ");

/** The path prefixes REVIEW.md "High-risk paths" lists (`src/policy/**` → `src/policy/`). */
export function highRiskPaths(review: string): string[] {
  const section = review.split("## High-risk paths")[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/`([^`]+)`/g)]
    .map((m) => (m[1] ?? "").replace(/\*\*$/, ""))
    .filter((p) => p.includes("/"));
}

/** The review tier of the session's work: an open follow-up if `bun run next` lists one, else the next task. */
export function tierFor(nextOutput: string, risk: readonly string[]): Tier {
  const followups = nextOutput.split("## Follow-ups to fix first")[1]?.split(/^## /m)[0] ?? "";
  const first = followups.split(/^(?=### F)/m).find((block) => block.startsWith("### F"));
  const work = first ?? nextOutput.split(/^## Task /m)[1]?.split(/^## /m)[0] ?? "";
  const paths = [...work.matchAll(/`([^`\s]+\/[^`\s]*)`/g)].map((m) => m[1] ?? "");
  if (paths.some((p) => risk.some((r) => p.startsWith(r)))) return "deep";
  if (/nothing in `src\/`/.test(work) || (paths.length > 0 && paths.every((p) => p.startsWith("docs/"))))
    return "quick";
  return "standard";
}

// Owner (2026-10-20): Sonnet always at high effort; Opus, for security work, at medium to spare the plan's limits.
export function modelFor(tier: Tier, model?: string): Pick {
  const picked: Record<Tier, Pick> = {
    quick: { model: "sonnet", effort: "high" },
    standard: { model: "sonnet", effort: "high" },
    deep: { model: "opus", effort: "medium" },
  };
  return model === undefined ? picked[tier] : { model, effort: picked[tier].effort };
}

/** The progress entry is written before the merge, so "merged" is only trusted once GitHub agrees. */
export function mergeCheck(entry: string, prState: (pr: number) => string): Decision | undefined {
  const pr = /PR: #(\d+) \(merged/.exec(entry)?.[1];
  if (pr === undefined) return undefined;
  const state = prState(Number(pr));
  return state === "MERGED"
    ? undefined
    : { action: "stop", reason: `the progress entry says PR #${pr} merged, but GitHub says it is ${state}` };
}

export function claudeArgs(opts: Options, pick: Pick): string[] {
  return [
    "claude",
    "-p",
    PROMPT,
    "--permission-mode",
    "auto",
    "--permission-prompts",
    "none",
    "--model",
    pick.model,
    "--effort",
    pick.effort,
    "--max-budget-usd",
    String(opts.budgetUsd),
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

const Result = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().default(""),
  total_cost_usd: z.number().default(0),
  session_id: z.string(),
});

export function parseRun(stdout: string): RunResult | { unreadable: string } {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return { unreadable: stdout.trim().slice(0, 500) };
  }
  const r = Result.safeParse(json);
  if (!r.success) return { unreadable: stdout.trim().slice(0, 500) };
  const d = r.data;
  return {
    isError: d.is_error,
    subtype: d.subtype,
    result: d.result,
    costUsd: d.total_cost_usd,
    sessionId: d.session_id,
  };
}

export function lastEntry(progress: string): { count: number; text: string } {
  const entries = progress.split(/^(?=## )/m).filter((e) => e.startsWith("## "));
  return { count: entries.length, text: (entries.at(-1) ?? "").trim() };
}

const MAX_OPEN_RUNS = 3;

/** Build loop step 7.4 leaves a PR open after three review rounds; this counts sessions in a row that did so for one task. */
export function openRuns(progress: string): number {
  const entries = progress.split(/^(?=## )/m).filter((e) => e.startsWith("## "));
  const taskOf = (e: string) => /^## \S+ — (\S+)/.exec(e)?.[1];
  const task = taskOf(entries.at(-1) ?? "");
  let n = 0;
  for (const e of entries.reverse()) {
    if (taskOf(e) !== task || !/PR: #\d+ \(open/.test(e)) break;
    n++;
  }
  return n;
}

export function decide(input: {
  exitCode: number;
  run: RunResult | { unreadable: string };
  before: number;
  after: { count: number; text: string };
  openRuns?: number;
}): Decision {
  const { run, after } = input;
  if ("unreadable" in run) return { action: "stop", reason: `couldn't read the run's result: ${run.unreadable}` };
  if (/hit your weekly limit/i.test(run.result)) return { action: "stop", reason: run.result };
  if (/hit your .*limit/i.test(run.result)) return { action: "wait", reason: run.result };
  if (run.subtype === "error_max_budget_usd") return { action: "stop", reason: "the run reached its budget cap" };
  if (run.isError || input.exitCode !== 0)
    return { action: "stop", reason: `the run failed (${run.subtype}): ${run.result}` };
  if (after.count <= input.before)
    return { action: "stop", reason: "the session finished without a new progress entry" };
  const next = /^Next:(.*)$/m.exec(after.text)?.[1] ?? "";
  if (/block|owner|waiting/i.test(next)) return { action: "stop", reason: `the next step needs you: ${next.trim()}` };
  if ((input.openRuns ?? 0) >= MAX_OPEN_RUNS) {
    const task = /^## \S+ — (\S+)/.exec(after.text)?.[1] ?? "the task";
    return { action: "stop", reason: `${task} is still not merged after ${MAX_OPEN_RUNS} sessions` };
  }
  return { action: "next" };
}

const Content = z.array(z.looseObject({ type: z.string() }));
const Message = z.looseObject({
  type: z.enum(["assistant", "user"]),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({ content: z.union([Content, z.string()]) }),
});
const Window = z.object({ utilization: z.number(), resetsAt: z.number() }).optional();
const RateLimit = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({
    status: z.string(),
    unifiedWindows: z.looseObject({ five_hour: Window, seven_day: Window }).optional(),
  }),
});

export type Feed = {
  tools: Map<string, string>;
  agents: Map<string, string>;
  fiveHour?: number;
  week?: number;
  fiveHourResetMs?: number;
  weekResetMs?: number;
};

export const newFeed = (): Feed => ({ tools: new Map(), agents: new Map() });

const oneLine = (text: unknown, max = 110): string => {
  const line = (typeof text === "string" ? text : "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function describeTool(name: string, input: Record<string, unknown>, root: string): string {
  const path = (key: string): string => {
    const p = typeof input[key] === "string" ? input[key] : "";
    return (p.startsWith(root) ? relative(root, p) : p).replaceAll("\\", "/");
  };
  if (name === "Read") return `read   ${path("file_path")}`;
  if (name === "Edit" || name === "MultiEdit") return `edit   ${path("file_path")}`;
  if (name === "Write") return `write  ${path("file_path")}`;
  if (name === "Bash") return `run    ${oneLine(input.command)}`;
  if (name === "Grep") return `search "${oneLine(input.pattern, 60)}"`;
  if (name === "Glob") return `find   ${oneLine(input.pattern, 60)}`;
  if (name === "WebFetch") return `fetch  ${oneLine(input.url)}`;
  if (name === "WebSearch") return `web    "${oneLine(input.query, 80)}"`;
  if (name === "TodoWrite") return "tasks  updated the to-do list";
  if (name === "Skill") return `skill  ${oneLine(input.skill, 60)}`;
  const mcp = /^mcp__(?:claude_ai_)?([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp !== null) return `docs   ${mcp[1]} ${mcp[2]}`;
  return `tool   ${name}`;
}

/** The terminal lines for one stream-json event; it also keeps tool names, agent names and plan usage in `feed`. */
export function describeEvent(event: unknown, feed: Feed, root: string): string[] {
  const limit = RateLimit.safeParse(event);
  if (limit.success) {
    const w = limit.data.rate_limit_info.unifiedWindows;
    if (w?.five_hour !== undefined) {
      feed.fiveHour = w.five_hour.utilization;
      feed.fiveHourResetMs = w.five_hour.resetsAt * 1000;
    }
    if (w?.seven_day !== undefined) {
      feed.week = w.seven_day.utilization;
      feed.weekResetMs = w.seven_day.resetsAt * 1000;
    }
    return [];
  }
  const msg = Message.safeParse(event);
  if (!msg.success || typeof msg.data.message.content === "string") return [];
  const parent = msg.data.parent_tool_use_id ?? null;
  const prefix = parent === null ? "" : `  [${feed.agents.get(parent) ?? "agent"}] `;
  const out: string[] = [];
  for (const part of msg.data.message.content) {
    if (part.type === "text" && msg.data.type === "assistant") {
      const text = oneLine(part.text, 140);
      if (text !== "") out.push(`${prefix}says   ${text}`);
    } else if (part.type === "tool_use" && typeof part.name === "string" && typeof part.id === "string") {
      const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as Record<
        string,
        unknown
      >;
      feed.tools.set(part.id, part.name);
      if (part.name === "Agent" || part.name === "Task") {
        const type = oneLine(input.subagent_type, 40) || "helper";
        feed.agents.set(part.id, type);
        out.push(`${prefix}agent  ${type}: ${oneLine(input.description, 80)}`);
      } else out.push(`${prefix}${describeTool(part.name, input, root)}`);
    } else if (part.type === "tool_result" && part.is_error === true && typeof part.tool_use_id === "string") {
      const content = Array.isArray(part.content) ? JSON.stringify(part.content) : part.content;
      out.push(
        `  ✗ ${prefix.trim() === "" ? "" : `${prefix.trim()} `}${feed.tools.get(part.tool_use_id) ?? "tool"} failed: ${oneLine(content, 100)}`,
      );
    }
  }
  return out;
}

const clock = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

export function limitsLine(feed: Feed): string {
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const parts: string[] = [];
  if (feed.fiveHour !== undefined)
    parts.push(`5-hour ${pct(feed.fiveHour)} (resets ${clock(feed.fiveHourResetMs ?? 0)})`);
  if (feed.week !== undefined) parts.push(`week ${pct(feed.week)} (resets ${clock(feed.weekResetMs ?? 0)})`);
  return parts.length === 0 ? "plan usage: not reported yet" : `plan usage: ${parts.join(" · ")}`;
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const time = (): string => new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

type Control = { stopAfterTask: boolean; child?: Bun.Subprocess | undefined };

/** Runs one session, printing its steps live; returns the final result line. */
async function session(argv: string[], feed: Feed, control: Control): Promise<{ code: number; resultLine: string }> {
  // A separate process group: Ctrl+C reaches only this script, which decides what to do with the session.
  const child = Bun.spawn(argv, {
    cwd: ROOT,
    env: { ...process.env, ...IDENTITY },
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
    detached: true,
  });
  control.child = child;
  let resultLine = "";
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        if (line.trim() !== "") console.log(`${DIM}${time()}${RESET}  ${line}`);
        continue;
      }
      if (typeof event === "object" && event !== null && "type" in event && event.type === "result") resultLine = line;
      for (const text of describeEvent(event, feed, ROOT)) console.log(`${DIM}${time()}${RESET}  ${text}`);
    }
  }
  const code = await child.exited;
  control.child = undefined;
  return { code, resultLine };
}

async function run(argv: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(argv, { cwd: ROOT, stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

// The checkout, not origin/main: a task whose PR stays open writes its entry only on its branch.
async function progress(): Promise<string> {
  return Bun.file(join(ROOT, "docs/plan/tasks/PROGRESS.md")).text();
}

function prStateOf(pr: number): string {
  const r = Bun.spawnSync(["gh", "pr", "view", String(pr), "--json", "state", "--jq", ".state"], { cwd: ROOT });
  return r.exitCode === 0 ? r.stdout.toString().trim() : `unknown (gh exited ${r.exitCode})`;
}

// An unattended run that stops silently looks like one still working; tell the owner.
async function notify(text: string): Promise<void> {
  const bin = Bun.which("notify-send");
  if (bin === null) {
    process.stdout.write("\x07");
    return;
  }
  const code = await Bun.spawn([bin, "Dovet", text]).exited;
  if (code !== 0) console.log(`${DIM}(notify-send exited ${code})${RESET}`);
}

function log(line: Record<string, unknown>): void {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const control: Control = { stopAfterTask: false };
  process.on("SIGINT", () => {
    if (!control.stopAfterTask) {
      control.stopAfterTask = true;
      console.log(`\n${BOLD}[auto] stopping after this task.${RESET} Press Ctrl+C again to stop now.`);
      return;
    }
    console.log(`\n${BOLD}[auto] stopping now.${RESET} The next session will finish or undo the half-done task.`);
    control.child?.kill("SIGINT");
    process.exit(130);
  });
  for (const signal of ["SIGHUP", "SIGTERM"] as const) {
    process.on(signal, () => {
      control.child?.kill("SIGTERM");
      process.exit(143);
    });
  }
  const feed = newFeed();
  let total = 0;
  for (let task = 1, waits = 0; task <= opts.tasks; ) {
    const before = lastEntry(await progress()).count;
    const started = Date.now();
    const tier = tierFor(
      (await run(["bun", "run", "next"])).stdout,
      highRiskPaths(await Bun.file(join(ROOT, "REVIEW.md")).text()),
    );
    const pick = modelFor(tier, opts.model);
    console.log(
      `\n${BOLD}[auto] task ${task} of ${opts.tasks}${RESET} · fresh session · ${tier} tier: ${pick.model} at ${pick.effort} effort`,
    );
    console.log(`${DIM}       Ctrl+C: stop after this task · twice: stop now${RESET}`);
    const { code, resultLine } = await session(claudeArgs(opts, pick), feed, control);
    const result = parseRun(resultLine === "" ? "(no result)" : resultLine);
    const text = await progress();
    const after = lastEntry(text);
    const decided = decide({ exitCode: code, run: result, before, after, openRuns: openRuns(text) });
    const decision = decided.action === "next" ? (mergeCheck(after.text, (pr) => prStateOf(pr)) ?? decided) : decided;
    const cost = "unreadable" in result ? 0 : result.costUsd;
    total += cost;
    const minutes = Math.round((Date.now() - started) / 60000);
    log({
      task,
      tier,
      model: pick.model,
      effort: pick.effort,
      exitCode: code,
      minutes,
      costUsd: cost,
      decision,
      entry: after.text.split("\n")[0] ?? "",
    });
    console.log(
      `${BOLD}[auto]${RESET} ${minutes} min · estimated $${cost.toFixed(2)} (this run $${total.toFixed(2)}) · ${limitsLine(feed)}`,
    );
    if (decision.action === "stop") {
      console.log(`${BOLD}[auto] stopped:${RESET} ${decision.reason}`);
      await notify(`Dovet auto stopped: ${decision.reason}`);
      return;
    }
    if (decision.action === "wait") {
      if (++waits > MAX_LIMIT_WAITS) {
        console.log(`${BOLD}[auto] stopped:${RESET} the usage limit didn't reset in time`);
        return;
      }
      const until =
        feed.fiveHourResetMs !== undefined && feed.fiveHourResetMs > Date.now()
          ? feed.fiveHourResetMs + 60_000
          : Date.now() + LIMIT_WAIT_MS;
      console.log(
        `${BOLD}[auto]${RESET} usage limit reached; waiting until ${new Date(until).toLocaleTimeString()} (${decision.reason})`,
      );
      await Bun.sleep(until - Date.now());
      continue;
    }
    console.log(`${BOLD}[auto] done:${RESET} ${after.text.split("\n")[0]?.replace(/^## /, "") ?? ""}`);
    waits = 0;
    task++;
    if (control.stopAfterTask && task <= opts.tasks) {
      console.log(`${BOLD}[auto] stopped after the task, as asked.${RESET}`);
      return;
    }
  }
  console.log(
    `\n${BOLD}[auto] finished ${opts.tasks} task(s)${RESET}; estimated total $${total.toFixed(2)}. Log: auto-runs.log`,
  );
  await notify(`Dovet auto finished ${opts.tasks} task(s)`);
}

if (import.meta.main) await main();
