// Build Dovet unattended: one fresh `claude -p` session per task, as the Claude Code docs recommend.
//
//     bun run auto                    # 3 tasks, Sonnet builds (the reviewer agent stays on Opus), $20 cap per run
//     bun run auto 5 --model opus --budget 30
//
// It stops when a run fails, records no progress entry, or leaves a task waiting for the owner. A session usage
// limit waits for the reset and retries; a weekly limit stops. Each run is logged to auto-runs.log.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ROOT = join(import.meta.dir, "..");
const LOG = join(ROOT, "auto-runs.log");
const LIMIT_WAIT_MS = 30 * 60 * 1000;
const MAX_LIMIT_WAITS = 12;

export type Options = { tasks: number; model: string; budgetUsd: number };
export type RunResult = { isError: boolean; subtype: string; result: string; costUsd: number; sessionId: string };
export type Decision = { action: "next" } | { action: "wait" | "stop"; reason: string };

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { tasks: 3, model: "sonnet", budgetUsd: 20 };
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
  "If the next step needs the owner, write that in the progress entry's Next line and stop.",
].join(" ");

export function claudeArgs(opts: Options): string[] {
  return [
    "claude",
    "-p",
    PROMPT,
    "--permission-mode",
    "auto",
    "--permission-prompts",
    "none",
    "--model",
    opts.model,
    "--max-budget-usd",
    String(opts.budgetUsd),
    "--output-format",
    "json",
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

export function decide(input: {
  exitCode: number;
  run: RunResult | { unreadable: string };
  before: number;
  after: { count: number; text: string };
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
  return { action: "next" };
}

async function run(argv: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(argv, { cwd: ROOT, stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

async function mainProgress(): Promise<{ count: number; text: string }> {
  await run(["git", "fetch", "-q", "origin", "main"]);
  return lastEntry((await run(["git", "show", "origin/main:docs/plan/tasks/PROGRESS.md"])).stdout);
}

function log(line: Record<string, unknown>): void {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  let total = 0;
  for (let task = 1, waits = 0; task <= opts.tasks; ) {
    const before = (await mainProgress()).count;
    console.log(`\n[auto] task ${task} of ${opts.tasks}: starting a fresh session (${opts.model})`);
    const { code, stdout } = await run(claudeArgs(opts));
    const result = parseRun(stdout);
    const after = await mainProgress();
    const decision = decide({ exitCode: code, run: result, before, after });
    const cost = "unreadable" in result ? 0 : result.costUsd;
    total += cost;
    log({ task, model: opts.model, exitCode: code, costUsd: cost, decision, entry: after.text.split("\n")[0] ?? "" });
    console.log(`[auto] estimated cost $${cost.toFixed(2)} (run total $${total.toFixed(2)})`);
    if (decision.action === "stop") {
      console.log(`[auto] stopped: ${decision.reason}`);
      return;
    }
    if (decision.action === "wait") {
      if (++waits > MAX_LIMIT_WAITS) {
        console.log("[auto] stopped: the usage limit didn't reset after 6 hours");
        return;
      }
      console.log(`[auto] usage limit reached; waiting 30 minutes (${decision.reason})`);
      await Bun.sleep(LIMIT_WAIT_MS);
      continue;
    }
    console.log(`[auto] done: ${after.text.split("\n")[0] ?? ""}`);
    waits = 0;
    task++;
  }
  console.log(`\n[auto] finished ${opts.tasks} task(s); estimated total $${total.toFixed(2)}. Log: auto-runs.log`);
}

if (import.meta.main) await main();
