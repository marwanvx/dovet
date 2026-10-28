// Check the docs the way CI does: bun run docs:check  (exit 1 on any problem).
//
// 1. Every spec's "Before you build" box is current (scripts/docs-context.ts --check).
// 2. No broken relative links in docs/ or AGENTS.md.
// 3. Acceptance-criterion IDs are unique, and every reference names an existing criterion.
// 4. Every criterion (except struck-through ones) is in exactly one task's "Done when" line.
// 5. Every task's dependencies exist, and its "Read" links resolve to real sections (scripts/next.ts).
// 6. Every answered question names where its answer is written (a `- **Spec:**` line).
// 7. The always-loaded instruction files and every task's `bun run next` output stay under their token ceilings.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { updateBoxes } from "./docs-context.ts";
import { milestones, NOT_FOUND, parseTasks, report } from "./next.ts";

const ROOT = join(import.meta.dir, "..");
const count = <T>(items: T[]): Map<T, number> => {
  const m = new Map<T, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
};

/** Every acceptance criterion defined in the docs, and the struck-through (removed) ones. */
export function criteria(root = ROOT): { defined: Map<string, number>; struck: Set<string>; referenced: Set<string> } {
  const texts = markdownFiles(root).map((p) => readFileSync(join(root, p), "utf8"));
  const struck = new Set([...texts.join("").matchAll(/~~\*\*(AC-[A-Z]+-\d+)\*\*~~/g)].map((m) => m[1] ?? ""));
  const defined = count(
    texts.flatMap((t) => [...t.matchAll(/(?<!~~)\*\*(AC-[A-Z]+-\d+)\*\*/g)].map((m) => m[1] ?? "")),
  );
  const referenced = new Set(texts.flatMap((t) => [...t.matchAll(/AC-[A-Z]+-\d+/g)].map((m) => m[0])));
  return { defined, struck, referenced };
}

/** Answered questions with no `- **Spec:**` line: their answer may live only in QUESTIONS.md. */
export function answersWithoutSpec(questions: string): string[] {
  const answered = questions.split("## Answered")[1] ?? "";
  return answered
    .split(/^(?=### Q\d+)/m)
    .filter((block) => /^### Q\d+/.test(block) && !/^- \*\*Spec:\*\* /m.test(block))
    .map((block) => /^### (Q\d+)/.exec(block)?.[1] ?? "");
}

// Ceilings in tokens (about 4 characters each), just above the sizes on 2026-10-20; lower them when the text shrinks.
// Every session loads these and resends them on every turn (docs/background/workflow-audit-2026-10-19.md).
export const CONTEXT_BUDGET = { "instruction files": 7500, "bun run next": 15400 } as const;
const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "REVIEW.md",
  "docs/workflow/build-loop.md",
  ".claude/agents/reviewer.md",
  ".claude/skills/ship-task/SKILL.md",
];

export function overBudget(sizes: Record<string, number>, budgets: Record<string, number>): string[] {
  return Object.entries(sizes).flatMap(([source, tokens]) => {
    const ceiling = budgets[source] ?? (source.startsWith("bun run next") ? budgets["bun run next"] : undefined);
    return ceiling !== undefined && tokens > ceiling
      ? [`${source}: about ${tokens} tokens, over its ceiling of ${ceiling}`]
      : [];
  });
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined; // not a git checkout (a source archive): the file on disk is all there is
  }
}

/** A skip-worktree file is an owner's local variant (`git ls-files -v` flag S): it counts as what git holds, so a local run
 * measures what CI measures. Any other file counts as it is on disk. */
export function instructionText(root: string, file: string): string {
  if (git(root, ["ls-files", "-v", "--", file])?.startsWith("S ")) {
    const held = git(root, ["show", `:${file}`]);
    if (held !== undefined) return held;
  }
  return readFileSync(join(root, file), "utf8");
}

function contextSizes(root: string, taskIds: Iterable<string>): Record<string, number> {
  const tokens = (text: string): number => Math.round(text.length / 4);
  const sizes: Record<string, number> = {
    "instruction files": INSTRUCTION_FILES.reduce((sum, f) => sum + tokens(instructionText(root, f)), 0),
  };
  for (const id of taskIds) sizes[`bun run next ${id}`] = tokens(report(id));
  return sizes;
}

function markdownFiles(root: string): string[] {
  return [...new Bun.Glob("docs/**/*.md").scanSync({ cwd: root })]
    .map((p) => p.replaceAll("\\", "/"))
    .filter((p) => !p.startsWith("docs/bun-docs/")) // vendored snapshot: its links point at bun.com
    .concat("AGENTS.md");
}

export function checkDocs(): string[] {
  const problems: string[] = [];

  const { stale, missing } = updateBoxes(true);
  if (missing.length) problems.push(`No milestone entry for: ${missing.join(", ")}`);
  if (stale.length) problems.push(`Out-of-date 'Before you build' boxes: ${stale.join(", ")}`);

  for (const p of markdownFiles(ROOT)) {
    const text = readFileSync(join(ROOT, p), "utf8").replace(/```.*?```/gs, ""); // ignore code blocks
    for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      const target = m[1] ?? "";
      if (/^[a-z]+:/.test(target)) continue;
      if (!existsSync(normalize(join(ROOT, dirname(p), target)))) problems.push(`broken link in ${p}: ${target}`);
    }
  }

  const { defined, struck, referenced } = criteria();
  for (const [a, n] of defined) if (n > 1) problems.push(`criterion defined twice: ${a}`);
  for (const a of [...referenced].sort()) {
    if (!defined.has(a) && !struck.has(a)) problems.push(`unknown criterion referenced: ${a}`);
  }

  const placed: string[] = [];
  const taskIds = new Set<string>();
  const deps: string[] = [];
  for (const [, text] of milestones()) {
    for (const m of text.matchAll(/^### (M\d+-\d+\w*)/gm)) taskIds.add(m[1] ?? "");
    for (const line of text.split("\n")) {
      if (line.startsWith("- **Done when:**"))
        placed.push(...new Set([...line.matchAll(/AC-[A-Z]+-\d+/g)].map((m) => m[0])));
      if (line.startsWith("- **Depends on:**")) deps.push(...[...line.matchAll(/M\d+-\d+\w*/g)].map((m) => m[0]));
    }
  }
  const placedCount = count(placed);
  for (const a of [...defined.keys()].sort()) {
    if (!struck.has(a) && !placedCount.has(a)) problems.push(`criterion in no task: ${a}`);
  }
  for (const [a, n] of placedCount) if (n > 1) problems.push(`criterion in several tasks: ${a}`);
  for (const d of [...new Set(deps)].sort()) if (!taskIds.has(d)) problems.push(`unknown task in Depends on: ${d}`);

  for (const id of [...taskIds].sort()) {
    if (report(id).includes(NOT_FOUND)) problems.push(`task ${id}: a Read link names a section that doesn't exist`);
  }

  for (const p of overBudget(contextSizes(ROOT, taskIds), CONTEXT_BUDGET)) problems.push(`context budget: ${p}`);

  const questions = readFileSync(join(ROOT, "docs", "plan", "tasks", "QUESTIONS.md"), "utf8");
  for (const q of answersWithoutSpec(questions)) {
    problems.push(`QUESTIONS ${q}: no "- **Spec:**" line naming where the answer is written (build loop step 6)`);
  }
  return problems;
}

/** Task statuses across every milestone file, for scripts/spec-coverage.ts. */
export function allTasks(root = ROOT): ReturnType<typeof parseTasks> {
  return milestones(root).flatMap(([, text]) => parseTasks(text));
}

if (import.meta.main) {
  const problems = checkDocs();
  if (problems.length) {
    console.log(problems.join("\n"));
    process.exit(1);
  }
  const { defined } = criteria();
  console.log(`docs OK: ${defined.size} criteria, ${allTasks().length} tasks, links and boxes current`);
}
