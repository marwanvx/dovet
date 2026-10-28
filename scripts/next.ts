// Print everything an agent needs to start its next session, in one go.
//
//     bun run next            # where the project stands + the next task + the exact spec text it needs
//     bun run next M0-03      # the same for a named task
//
// It reads docs/plan/tasks/ (task lists, PROGRESS.md, QUESTIONS.md) and the spec sections a task's
// "Read" line links to, and prints them, so the agent never has to guess which files matter.
// The build loop (docs/workflow/build-loop.md) tells agents to run this first.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TASKS = join(ROOT, "docs", "plan", "tasks");
export const NOT_FOUND = "Couldn't find those sections";

const read = (path: string): string => readFileSync(path, "utf8");

export type Task = { id: string; title: string; body: string; status: string; deps: string };

/** Task files in roadmap order (M0, M1, ...). */
export function milestones(root = ROOT): [string, string][] {
  const tasks = join(root, "docs", "plan", "tasks");
  return readdirSync(tasks)
    .filter((f) => /^M\d+\.md$/.test(f))
    .sort((a, b) => Number(a.slice(1, -3)) - Number(b.slice(1, -3)))
    .map((f) => [f.slice(0, -3), read(join(tasks, f))]);
}

export function parseTasks(text: string): Task[] {
  const tasks: Task[] = [];
  for (const m of text.matchAll(/^### (M\d+-\d+\w*) (.+?)\n(.*?)(?=^### |(?![\s\S]))/gms)) {
    const [, id = "", title = "", rawBody = ""] = m;
    const body = rawBody.trim();
    const status = /\*\*Status:\*\*\s*(.+)/.exec(body);
    const deps = /\*\*Depends on:\*\*\s*(.+)/.exec(body);
    tasks.push({
      id,
      title: title.trim(),
      body,
      status: status?.[1]?.trim() ?? "todo",
      deps: deps?.[1]?.trim() ?? "—",
    });
  }
  return tasks;
}

export const isDone = (status: string): boolean => status.startsWith("done");

function depsDone(task: Task, byId: Map<string, Task>): boolean {
  if (["—", "-", ""].includes(task.deps)) return true;
  if (task.deps.startsWith("all other")) return [...byId.values()].every((t) => t.id === task.id || isDone(t.status));
  return [...task.deps.matchAll(/M\d+-\d+\w*/g)].every((d) => {
    const dep = byId.get(d[0]);
    return !dep || isDone(dep.status);
  });
}

/** The parts of a markdown doc whose headings match the wanted § numbers or quoted titles, with their 1-based line range. */
export function sections(doc: string, wanted: string[]): { text: string; from: number; to: number }[] {
  const heads = [...doc.matchAll(/^(#{2,4}) (.+)$/gm)].map((m) => ({
    pos: m.index,
    level: m[1]?.length ?? 0,
    title: (m[2] ?? "").trim(),
  }));
  const lineAt = (pos: number): number => doc.slice(0, pos).split("\n").length;
  const out: { text: string; from: number; to: number }[] = [];
  const covered: [number, number][] = [];
  heads.forEach(({ pos, level, title }, i) => {
    if (covered.some(([a, b]) => a <= pos && pos < b)) return; // already inside a printed section
    const num = /^(\d+[a-z]?(?:\.\d+)?)\.?\s/.exec(title);
    const hit = wanted.some(
      (w) => (num && num[1] === w) || (!/^\d/.test(w) && title.toLowerCase().includes(w.toLowerCase())),
    );
    if (!hit) return;
    const end = heads.slice(i + 1).find((h) => h.level <= level)?.pos ?? doc.length;
    covered.push([pos, end]);
    const text = doc.slice(pos, end).trimEnd();
    const from = lineAt(pos);
    out.push({ text, from, to: from + text.split("\n").length - 1 });
  });
  return out;
}

function box(doc: string): string {
  const m = /<!-- before-you-build:start -->(.*?)<!-- before-you-build:end -->/s.exec(doc);
  return m?.[1]?.trim() ?? "";
}

type Reading = { rel: string; label: string; box: string; parts: string[]; hadSections: boolean };

function readingFor(task: Task): Reading[] {
  const readLine = /\*\*Read:\*\*(.+)/.exec(task.body);
  if (!readLine?.[1]) return [];
  const out: Reading[] = [];
  for (const [, label = "", target = ""] of readLine[1].matchAll(/\[([^\]]+)\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const path = normalize(join(TASKS, target));
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const text = read(path);
    const rel = relative(ROOT, path).split(sep).join("/");
    const wanted = [
      ...[...label.matchAll(/§\s*(\d+[a-z]?(?:\.\d+)?)/g)].map((m) => m[1] ?? ""),
      ...[...label.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""),
    ];
    const parts = wanted.length ? sections(text, wanted).map((p) => `(${rel} lines ${p.from}–${p.to})\n${p.text}`) : [];
    for (const [, n] of label.matchAll(/SPIKE-(\d+)/g)) {
      // a spike reference prints its table row
      parts.push(...[...text.matchAll(new RegExp(`^\\| SPIKE-${n} \\|.*$`, "gm"))].map((m) => m[0]));
      wanted.push(`SPIKE-${n}`);
    }
    out.push({ rel, label, box: box(text), parts, hadSections: wanted.length > 0 });
  }
  return out;
}

function tailEntries(text: string, n: number): string {
  const entries = text.split(/(?=^## )/m).filter((e) => e.startsWith("## "));
  return entries.slice(-n).join("");
}

/** The session-start report: for the next task, or for `want` (a task id). */
/** Answered questions where the owner added an `**Override (owner…` line that has no `**Override applied` yet. */
export function unappliedOverrides(questions: string): string {
  const answered = questions.split("## Answered")[1] ?? "";
  return answered
    .split(/^(?=### )/m)
    .filter((block) => block.includes("**Override (owner") && !block.includes("**Override applied"))
    .map((block) => block.trim())
    .join("\n\n");
}

const SEVERITY_RANK: Record<string, number> = { blocker: 0, major: 1 };
const rank = (block: string): number => SEVERITY_RANK[/^- \*\*Severity:\*\* (\w+)/m.exec(block)?.[1] ?? ""] ?? 2;
const number = (block: string): number => Number(/^### F(\d+)/.exec(block)?.[1] ?? Number.MAX_SAFE_INTEGER);

/** Open blockers and majors in the order step 2.4 works them: blockers first, then the oldest (lowest F number). */
export function urgentFollowups(followups: string): string {
  const open = followups.split("## Open")[1]?.split("## Fixed")[0] ?? "";
  return open
    .split(/^(?=### )/m)
    .filter((block) => /^- \*\*Severity:\*\* (blocker|major)\b/m.test(block))
    .sort((a, b) => rank(a) - rank(b) || number(a) - number(b))
    .map((block) => block.trim())
    .join("\n\n");
}

/** The session's follow-up in full; its `Class:` members and the others as ids, so the runner and the agent read the same one. */
export function followupSection(urgent: string): string {
  const [first, ...rest] = urgent
    .split(/^(?=### )/m)
    .map((block) => block.trim())
    .filter(Boolean);
  if (first === undefined) return "";
  const id = (block: string): string => /^### (F\d+)/.exec(block)?.[1] ?? "?";
  const label = (block: string): string => `${id(block)} (${/\*\*Severity:\*\* (\w+)/.exec(block)?.[1] ?? "?"})`;
  const members = new Set(/\*\*Class:\*\*[^\n]*\(([^)]*)\)/.exec(first)?.[1]?.match(/F\d+/g) ?? []);
  const same = rest.filter((block) => members.has(id(block)));
  const others = rest.filter((block) => !members.has(id(block)));
  const parts = [first];
  if (same.length > 0)
    parts.push(
      `Same cause, close them in this PR (their entries are in docs/plan/tasks/FOLLOWUPS.md): ${same.map(label).join(", ")}`,
    );
  if (others.length > 0) parts.push(`Also open, not this session's work: ${others.map(label).join(", ")}`);
  return parts.join("\n\n");
}

export function report(want?: string): string {
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
  };
  const ms = milestones();
  print("# Session start (generated by scripts/next.ts)\n");
  const q = read(join(TASKS, "QUESTIONS.md"));
  const waiting = q.includes("## Waiting for the owner")
    ? (q.split("## Waiting for the owner")[1]?.split("## Answered")[0]?.trim() ?? "")
    : "";
  print(`## Waiting for the owner (only what no agent can do)\n${waiting || "(none)"}\n`);
  print(`## Owner overrides to apply\n${unappliedOverrides(q) || "(none)"}\n`);
  const followupsPath = join(TASKS, "FOLLOWUPS.md");
  const followups = existsSync(followupsPath) ? followupSection(urgentFollowups(read(followupsPath))) : "";
  print(`## Follow-ups to fix first (build loop step 2.4)\n${followups || "(none)"}\n`);
  print(`## Last progress entries\n${tailEntries(read(join(TASKS, "PROGRESS.md")), 2).trim()}\n`);

  for (const [name, text] of ms) {
    const tasks = parseTasks(text);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    let task: Task | undefined;
    if (want) {
      task = byId.get(want);
      if (!task) continue;
    } else {
      if (tasks.length && tasks.every((t) => isDone(t.status))) continue;
      task =
        tasks.find((t) => t.status.startsWith("in-progress")) ??
        tasks.find((t) => t.status === "todo" && depsDone(t, byId));
    }
    print(
      `## Current milestone: ${name}  (${tasks.filter((t) => isDone(t.status)).length}/${tasks.length} tasks done)\n`,
    );
    if (!task) {
      const blocked = tasks.filter((t) => t.status.startsWith("blocked")).map((t) => t.id);
      print(
        `No task can start now.${blocked.length ? ` Blocked: ${blocked.join(", ")} (waiting for the owner, see QUESTIONS.md).` : ""}`,
      );
      return lines.join("\n");
    }
    print(`## Task ${task.id} ${task.title}\n\n${task.body}\n`);
    print("## What to read (exact text; read nothing else unless a test failure points you there)\n");
    for (const r of readingFor(task)) {
      print(`### ${r.rel} — ${r.label}\n`);
      if (r.box) print(`${r.box}\n`);
      if (r.parts.length) print(`${r.parts.join("\n\n")}\n`);
      else if (r.hadSections) print(`(${NOT_FOUND} automatically: read them in ${r.rel}.)\n`);
      else print(`(Read the whole file: ${r.rel}.)\n`);
    }
    return lines.join("\n");
  }
  print(
    want
      ? `Task ${want} not found in docs/plan/tasks/.`
      : "Every task list is finished. Next: plan the next milestone (build loop step 4).",
  );
  return lines.join("\n");
}

if (import.meta.main) console.log(report(Bun.argv[2]));
