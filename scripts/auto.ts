// Build Dovet unattended: one fresh Claude Code session per task, each opened as the normal app in this terminal.
//
//     bun run auto                    # 3 tasks, model and effort picked per task from its risk tier
//     bun run auto 5 --model opus
//
// `claude -p` is metered ~2x faster against the 5-hour limit than the app (anthropics/claude-code#97074), so each
// task opens the app with its prompt already typed; you can watch it or step in. A Stop hook tells this script when
// the session is done; it then closes the app and opens a fresh one for the next task. Closing the app yourself
// stops the run (the next run finishes the half-done task).
// It stops when a session ends on an error, records no progress entry, leaves a task waiting for the owner, or leaves
// one task's PR open three sessions in a row (a PR left open after review goes on: the next session rethinks it). A
// 5-hour usage limit waits and retries; a weekly limit stops. Each run is logged to auto-runs.log.
import { appendFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const ROOT = join(import.meta.dir, "..");
const LOG = join(ROOT, "auto-runs.log");
const LIMIT_WAIT_MS = 30 * 60 * 1000;
const STUCK_MS = 30 * 60 * 1000;
// Commits must never carry the owner's personal email: the repository is public.
const IDENTITY = {
  GIT_AUTHOR_NAME: "Marwan",
  GIT_COMMITTER_NAME: "Marwan",
  GIT_AUTHOR_EMAIL: "154838093+marwanvx@users.noreply.github.com",
  GIT_COMMITTER_EMAIL: "154838093+marwanvx@users.noreply.github.com",
};
const MAX_LIMIT_WAITS = 12;

export type Options = { tasks: number; model?: string };
export type Tier = "quick" | "standard" | "deep";
export type Pick = { model: string; effort: string };
export type Ending =
  | { kind: "done"; message: string }
  | { kind: "failed"; error: string; message: string }
  | { kind: "closed" };
export type Decision = { action: "next" } | { action: "wait" | "stop"; reason: string };

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { tasks: 3 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--model") opts.model = argv[++i] ?? "";
    else if (arg === "--budget") throw new Error("--budget is gone: a dollar cap only works with claude -p");
    else if (/^\d+$/.test(arg) && Number(arg) > 0) opts.tasks = Number(arg);
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

export function claudeArgs(pick: Pick, session: { sessionId: string; name: string; settings: string }): string[] {
  return [
    "claude",
    PROMPT,
    "--permission-mode",
    "auto",
    "--model",
    pick.model,
    "--effort",
    pick.effort,
    "--session-id",
    session.sessionId,
    "--name",
    session.name,
    "--settings",
    session.settings,
  ];
}

/** `--settings` JSON whose Stop and StopFailure hooks append their input to `marker` (via `auto.ts --hook`). */
export function hookSettings(bun: string, script: string, marker: string): string {
  const command = `${JSON.stringify(bun)} ${JSON.stringify(script)} --hook ${JSON.stringify(marker)}`;
  const hook = [{ hooks: [{ type: "command", command }] }];
  return JSON.stringify({ hooks: { Stop: hook, StopFailure: hook } });
}

// A parent Claude Code session's own variables would make the app inherit its label and session.
const PARENT_SESSION = /^CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_.*|EXECPATH)$/;

export function appEnv(
  env: Record<string, string | undefined>,
  identity: Record<string, string>,
): Record<string, string | undefined> {
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => !PARENT_SESSION.test(k))), ...identity };
}

const HookEvent = z.looseObject({
  hook_event_name: z.string(),
  last_assistant_message: z.string().optional(),
  error: z.string().optional(),
  transcript_path: z.string().optional(),
  background_tasks: z.array(z.looseObject({ status: z.string().optional() })).optional(),
  session_crons: z.array(z.unknown()).optional(),
});

function hookEvents(marker: string): z.infer<typeof HookEvent>[] {
  const events: z.infer<typeof HookEvent>[] = [];
  for (const line of marker.split("\n")) {
    if (line.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      continue;
    }
    const event = HookEvent.safeParse(json);
    if (event.success) events.push(event.data);
  }
  return events;
}

/** How the session ended, from its hook events; undefined while it is still working. */
export function sessionEnding(marker: string): Ending | undefined {
  const last = hookEvents(marker).at(-1);
  if (last === undefined) return undefined;
  const message = last.last_assistant_message ?? "";
  if (last.hook_event_name === "StopFailure") return { kind: "failed", error: last.error ?? "unknown", message };
  if (last.hook_event_name !== "Stop") return undefined;
  // A stop with background work in flight is a pause: Claude Code wakes the session again when the work finishes.
  const busy = (last.background_tasks ?? []).some((t) => t.status === undefined || /running|pending/.test(t.status));
  if (busy || (last.session_crons ?? []).length > 0) return undefined;
  return { kind: "done", message };
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
  ending: Ending;
  before: number;
  after: { count: number; text: string };
  openRuns?: number;
}): Decision {
  const { ending, after } = input;
  if (ending.kind === "closed") return { action: "stop", reason: "the app was closed before the session finished" };
  if (ending.kind === "failed") {
    if (/weekly limit/i.test(ending.message)) return { action: "stop", reason: ending.message };
    if (ending.error === "rate_limit" || /hit your .*limit/i.test(ending.message))
      return { action: "wait", reason: ending.message || ending.error };
    return { action: "stop", reason: `the session ended on an API error (${ending.error}): ${ending.message}` };
  }
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

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const time = (): string => new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

type Control = { child?: Bun.Subprocess | undefined };

/** The newest change to the session's transcript or its helper agents' transcripts; undefined until it exists. */
function lastActivity(sessionId: string): number | undefined {
  const projects = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude"),
    "projects",
  );
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const transcript = join(projects, dir, `${sessionId}.jsonl`);
    const stat = statSync(transcript, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    let newest = stat.mtimeMs;
    const helpers = join(dirname(transcript), sessionId);
    if (existsSync(helpers))
      for (const f of readdirSync(helpers, { recursive: true }))
        newest = Math.max(newest, statSync(join(helpers, String(f)), { throwIfNoEntry: false })?.mtimeMs ?? 0);
    return newest;
  }
  return undefined;
}

/** Opens the app in this terminal for one task and closes it once its Stop hook says it is done. */
async function session(pick: Pick, name: string, control: Control): Promise<Ending> {
  const sessionId = crypto.randomUUID();
  const marker = join(tmpdir(), `dovet-auto-${sessionId}.jsonl`);
  const settings = hookSettings(process.execPath, join(import.meta.dir, "auto.ts"), marker);
  // Same process group as this script: the app needs the terminal's foreground to read keys.
  const child = Bun.spawn(claudeArgs(pick, { sessionId, name, settings }), {
    cwd: ROOT,
    env: appEnv(process.env, IDENTITY),
    stdio: ["inherit", "inherit", "inherit"],
  });
  control.child = child;
  const started = Date.now();
  let warned = false;
  let ending: Ending | undefined;
  for (;;) {
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
    const file = Bun.file(marker);
    ending = sessionEnding((await file.exists()) ? await file.text() : "");
    if (ending !== undefined) break;
    if (exited) {
      ending = { kind: "closed" };
      break;
    }
    if (!warned && Date.now() - (lastActivity(sessionId) ?? started) > STUCK_MS) {
      warned = true;
      await notify("Dovet auto: the session has been quiet for 30 minutes; it may be waiting for you");
    }
  }
  if (child.exitCode === null) {
    // Let the app finish writing the transcript after the Stop hook before closing it.
    await Bun.sleep(3000);
    child.kill("SIGTERM");
    await child.exited;
  }
  control.child = undefined;
  rmSync(marker, { force: true });
  return ending;
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
  const argv = Bun.argv.slice(2);
  // The Stop/StopFailure hook: Claude Code pipes the event's JSON in; one line per event.
  if (argv[0] === "--hook" && argv[1] !== undefined) {
    appendFileSync(argv[1], `${(await Bun.stdin.text()).replaceAll("\n", " ").trim()}\n`);
    return;
  }
  const opts = parseArgs(argv);
  const control: Control = {};
  // While the app is open, Ctrl+C belongs to it (twice closes it, which stops the run); between tasks it stops now.
  process.on("SIGINT", () => {
    if (control.child !== undefined) return;
    console.log(`\n${BOLD}[auto] stopped.${RESET}`);
    process.exit(130);
  });
  for (const signal of ["SIGHUP", "SIGTERM"] as const) {
    process.on(signal, () => {
      control.child?.kill("SIGTERM");
      process.exit(143);
    });
  }
  for (let task = 1, waits = 0; task <= opts.tasks; ) {
    const before = lastEntry(await progress()).count;
    const started = Date.now();
    const tier = tierFor(
      (await run(["bun", "run", "next"])).stdout,
      highRiskPaths(await Bun.file(join(ROOT, "REVIEW.md")).text()),
    );
    const pick = modelFor(tier, opts.model);
    console.log(
      `\n${BOLD}[auto] task ${task} of ${opts.tasks}${RESET} · opening the app · ${tier} tier: ${pick.model} at ${pick.effort} effort`,
    );
    console.log(`${DIM}       It closes by itself when the task is done. Closing it yourself stops the run.${RESET}`);
    await Bun.sleep(2000);
    const ending = await session(pick, `dovet auto ${time()} task ${task}`, control);
    const text = await progress();
    const after = lastEntry(text);
    const decided = decide({ ending, before, after, openRuns: openRuns(text) });
    const decision = decided.action === "next" ? (mergeCheck(after.text, (pr) => prStateOf(pr)) ?? decided) : decided;
    const minutes = Math.round((Date.now() - started) / 60000);
    log({
      task,
      tier,
      model: pick.model,
      effort: pick.effort,
      minutes,
      ending: ending.kind === "failed" ? `failed: ${ending.error}` : ending.kind,
      decision,
      entry: after.text.split("\n")[0] ?? "",
    });
    console.log(`\n${BOLD}[auto]${RESET} task ${task} took ${minutes} min`);
    if (decision.action === "stop") {
      console.log(`${BOLD}[auto] stopped:${RESET} ${decision.reason}`);
      await notify(`Dovet auto stopped: ${decision.reason}`);
      return;
    }
    if (decision.action === "wait") {
      if (++waits > MAX_LIMIT_WAITS) {
        console.log(`${BOLD}[auto] stopped:${RESET} the usage limit didn't reset in time`);
        await notify("Dovet auto stopped: the usage limit didn't reset in time");
        return;
      }
      const until = Date.now() + LIMIT_WAIT_MS;
      console.log(
        `${BOLD}[auto]${RESET} usage limit reached; trying again at ${new Date(until).toLocaleTimeString()} (${decision.reason})`,
      );
      await Bun.sleep(until - Date.now());
      continue;
    }
    console.log(`${BOLD}[auto] done:${RESET} ${after.text.split("\n")[0]?.replace(/^## /, "") ?? ""}`);
    waits = 0;
    task++;
  }
  console.log(`\n${BOLD}[auto] finished ${opts.tasks} task(s).${RESET} Log: auto-runs.log`);
  await notify(`Dovet auto finished ${opts.tasks} task(s)`);
}

if (import.meta.main) await main();
