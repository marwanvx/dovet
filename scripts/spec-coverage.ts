// The criterion-to-test check (docs/specs/testing.md "Coverage targets"), part of `bun run check`:
// fails if a `// spec: AC-xx-yy` tag names an unknown criterion, or if a criterion listed under "Done when" of a task
// marked `done` in docs/plan/tasks/ has no tagged test. Criteria of tasks not built yet aren't checked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allTasks, criteria } from "./check-docs.ts";
import { isDone } from "./next.ts";

const ROOT = join(import.meta.dir, "..");
const TEST_FILES = ["src/**/*.test.ts", "test/**/*.test.ts", "scripts/**/*.test.ts"];

/** The criterion IDs named by `// spec:` tags in one file. */
export function tagsIn(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.matchAll(/\/\/\s*spec:([^\n]*)/g)) {
    for (const id of (line[1] ?? "").matchAll(/AC-[A-Z]+-\d+/g)) ids.add(id[0]);
  }
  return ids;
}

export type CoverageInput = {
  known: Set<string>;
  done: { task: string; criteria: string[] }[];
  tags: Map<string, Set<string>>;
};

export function coverageProblems({ known, done, tags }: CoverageInput): string[] {
  const problems: string[] = [];
  const tagged = new Set<string>();
  for (const [file, ids] of [...tags].sort(([a], [b]) => a.localeCompare(b))) {
    for (const id of [...ids].sort()) {
      tagged.add(id);
      if (!known.has(id)) problems.push(`unknown criterion in a test tag: ${id} (${file})`);
    }
  }
  for (const { task, criteria } of done) {
    for (const id of criteria) {
      if (!tagged.has(id)) problems.push(`criterion of done task ${task} has no tagged test: ${id}`);
    }
  }
  return problems;
}

function repoInput(): CoverageInput {
  const { defined } = criteria();
  const done = allTasks()
    .filter((t) => isDone(t.status))
    .map((t) => {
      const line = /\*\*Done when:\*\*(.+)/.exec(t.body)?.[1] ?? "";
      return { task: t.id, criteria: [...new Set([...line.matchAll(/AC-[A-Z]+-\d+/g)].map((m) => m[0]))] };
    });
  const tags = new Map<string, Set<string>>();
  for (const pattern of TEST_FILES) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: ROOT })) {
      const ids = tagsIn(readFileSync(join(ROOT, file), "utf8"));
      if (ids.size) tags.set(file.replaceAll("\\", "/"), ids);
    }
  }
  return { known: new Set(defined.keys()), done, tags };
}

if (import.meta.main) {
  const input = repoInput();
  const problems = coverageProblems(input);
  if (problems.length) {
    console.log(problems.join("\n"));
    process.exit(1);
  }
  const required = input.done.reduce((n, d) => n + d.criteria.length, 0);
  console.log(`spec coverage OK: ${required} criteria of done tasks covered; ${input.tags.size} test files tagged`);
}
