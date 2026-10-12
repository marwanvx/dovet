// Check the docs the way CI does: bun run docs:check  (exit 1 on any problem).
//
// 1. Every spec's "Before you build" box is current (scripts/docs-context.ts --check).
// 2. No broken relative links in docs/ or AGENTS.md.
// 3. Acceptance-criterion IDs are unique, and every reference names an existing criterion.
// 4. Every criterion (except struck-through ones) is in exactly one task's "Done when" line.
// 5. Every task's dependencies exist, and its "Read" links resolve to real sections (scripts/next.ts).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { updateBoxes } from "./docs-context.ts";
import { milestones, NOT_FOUND, parseTasks, report } from "./next.ts";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const count = <T>(items: T[]): Map<T, number> => {
  const m = new Map<T, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
};

/** Every acceptance criterion defined in the docs, and the struck-through (removed) ones. */
export function criteria(): { defined: Map<string, number>; struck: Set<string>; referenced: Set<string> } {
  const texts = markdownFiles().map(read);
  const struck = new Set([...texts.join("").matchAll(/~~\*\*(AC-[A-Z]+-\d+)\*\*~~/g)].map((m) => m[1] ?? ""));
  const defined = count(
    texts.flatMap((t) => [...t.matchAll(/(?<!~~)\*\*(AC-[A-Z]+-\d+)\*\*/g)].map((m) => m[1] ?? "")),
  );
  const referenced = new Set(texts.flatMap((t) => [...t.matchAll(/AC-[A-Z]+-\d+/g)].map((m) => m[0])));
  return { defined, struck, referenced };
}

function markdownFiles(): string[] {
  return [...new Bun.Glob("docs/**/*.md").scanSync({ cwd: ROOT })]
    .map((p) => p.replaceAll("\\", "/"))
    .concat("AGENTS.md");
}

export function checkDocs(): string[] {
  const problems: string[] = [];

  const { stale } = updateBoxes(true);
  if (stale.length) problems.push(`Out-of-date 'Before you build' boxes: ${stale.join(", ")}`);

  for (const p of markdownFiles()) {
    const text = read(p).replace(/```.*?```/gs, ""); // ignore code blocks
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
  return problems;
}

/** Task statuses across every milestone file, for scripts/spec-coverage.ts. */
export function allTasks(): ReturnType<typeof parseTasks> {
  return milestones().flatMap(([, text]) => parseTasks(text));
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
