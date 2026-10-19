// Exports that nothing but tests calls must name the task that will wire them (scripts/wiring.json).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const LEDGER = "scripts/wiring.json";

type Source = { path: string; text: string };
const isTest = (p: string): boolean => /\.test\.ts$|\/test-context\.ts$/.test(p);

/** `file:name` for every export in src/ that no non-test file other than its own (and index re-exports) mentions. */
export function unwiredExports(files: readonly Source[]): string[] {
  const callers = files.filter((f) => !isTest(f.path) && !f.path.endsWith("/index.ts"));
  const out: string[] = [];
  for (const f of files) {
    if (!f.path.startsWith("src/") || isTest(f.path) || f.path.includes("/vendor/")) continue;
    for (const m of f.text.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)) {
      const name = m[1] ?? "";
      const word = new RegExp(`\\b${name}\\b`, "g");
      const usedHere = (f.text.match(word) ?? []).length > 1;
      const usedElsewhere = callers.some((c) => c.path !== f.path && word.test(c.text));
      if (!usedHere && !usedElsewhere) out.push(`${f.path}:${name}`);
    }
  }
  return out.sort();
}

export function wiringProblems(
  unwired: readonly string[],
  ledger: Readonly<Record<string, string>>,
  status: (owner: string) => "open" | "done" | "unknown",
): string[] {
  const problems: string[] = [];
  for (const key of unwired) {
    const owner = ledger[key];
    if (owner === undefined) {
      problems.push(
        `${key} is called only by tests: add it to ${LEDGER} with the task that will wire it, or "test-only: <why>"`,
      );
    } else if (!owner.startsWith("test-only:")) {
      const s = status(owner);
      if (s === "unknown") problems.push(`${key}: owner ${owner} is not a task or follow-up id`);
      if (s === "done") problems.push(`${key}: ${owner} is done but nothing outside tests calls it yet`);
    }
  }
  for (const key of Object.keys(ledger)) {
    if (!unwired.includes(key)) problems.push(`${key} is wired now: remove it from ${LEDGER}`);
  }
  return problems;
}

/** A task's status from the task lists, a follow-up's from FOLLOWUPS.md. */
export function ownerStatus(tasks: string, followups: string): (owner: string) => "open" | "done" | "unknown" {
  return (owner) => {
    if (/^F\d+$/.test(owner)) {
      const open = followups.split("## Open")[1]?.split("## Fixed")[0] ?? "";
      const fixed = followups.split("## Fixed")[1] ?? "";
      if (new RegExp(`^### ${owner} `, "m").test(open)) return "open";
      return new RegExp(`^### ${owner} `, "m").test(fixed) ? "done" : "unknown";
    }
    const block = tasks.split(new RegExp(`^### ${owner} `, "m"))[1];
    if (block === undefined) return "unknown";
    return /^- \*\*Status:\*\* done/m.test(block.split(/^### /m)[0] ?? "") ? "done" : "open";
  };
}

export function checkWiring(root = ROOT): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "src/*.ts", "src/**/*.ts", "scripts/*.ts"], { cwd: root });
  const files = listed.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
  const tasks = Bun.spawnSync(["sh", "-c", "cat docs/plan/tasks/M*.md"], { cwd: root }).stdout.toString();
  const followups = readFileSync(join(root, "docs/plan/tasks/FOLLOWUPS.md"), "utf8");
  const ledger = JSON.parse(readFileSync(join(root, LEDGER), "utf8")) as Record<string, string>;
  return wiringProblems(unwiredExports(files), ledger, ownerStatus(tasks, followups));
}

if (import.meta.main) {
  const problems = checkWiring();
  if (problems.length) {
    console.log(problems.join("\n"));
    process.exit(1);
  }
  console.log("wiring OK: every export only tests call names its owner");
}
