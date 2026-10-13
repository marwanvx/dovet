// Generate the "Before you build" box at the top of each spec in docs/specs/.
//
// The box gathers, for one spec, what lives in the cross-cutting docs: the milestone(s) that build it
// (plan/roadmap.md), the decisions that apply (plan/decisions.md), the open spikes with their fallbacks
// (plan/open-questions.md) and the user journeys it serves (product/user-journeys.md). Agents then see
// everything relevant in the file they are reading.
//
// Run after editing those four files or any [SPIKE-n] / ADR reference:  bun run docs:boxes
// With --check it only reports specs whose box is out of date (exit 1), for CI (part of `bun run docs:check`).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOCS = join(import.meta.dir, "..", "docs");
const SPEC_DIR = join(DOCS, "specs");
const START = "<!-- before-you-build:start -->";
const END = "<!-- before-you-build:end -->";

// Which milestone builds which part of each spec (plan/roadmap.md is the source; keep in sync).
const MILESTONES: Record<string, string> = {
  architecture:
    "M0 (install layout, release pipeline, import-boundary check); later milestones follow the module rules",
  "event-log": "M1 (event log, resume, crash recovery); M2 (blob GC, disk use)",
  providers:
    "M1 (NVIDIA through `@ai-sdk/openai-compatible`, retries, adapter-contract proof on NVIDIA); M4 (OpenAI/Open Responses, Chinese providers, Chat fallback, registry, catalog, failover); Anthropic (M4-12) and Gemini (M4-08) only if the owner adds them",
  "agent-loop": "M1",
  tools:
    "M1 (Read, Write, Edit, Bash/PowerShell, Grep, Glob, AskUserQuestion, TodoWrite, plan-mode tools); M2 (WebFetch, WebSearch); M3 (dialogs)",
  permissions: "M1 (rules, modes, built-in checks, sensitive files); M2 (sandbox, taint, workspace trust, redaction)",
  context: "M1 (epochs, prompt assembly, instruction files, mid-epoch instructions); M2 (compaction)",
  "receipts-budgets": "M2 (cost, budgets, daily ledger); M3 (receipts, claim checker)",
  checkpoints: "M2",
  tui: "M1 (headless `-p`, output formats, exit codes); M3 (TUI)",
  "cli-config":
    "M1 (settings, precedence, secrets, startup); M3 (`/login`, first-run wizard, install scripts); M4 (registry-driven providers, OAuth logins)",
  extensibility: 'v0.2 (only the "v0.1 constraint" lines apply to v0.1 code)',
  platforms: "Every milestone (each feature is built for all three OSes)",
  testing: "Every milestone (each task's tests); M5 (evals, soak, release gates)",
  interfaces: "M1 (types are created with the modules that own them)",
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const read = (rel: string): string => readFileSync(join(DOCS, rel), "utf8");
const byNumber = (a: string, b: string): number => Number(a) - Number(b);

export function stripBox(text: string): string {
  return text.replace(new RegExp(`${escapeRegExp(START)}.*?${escapeRegExp(END)}\\n*`, "gs"), "");
}

type Adrs = Map<string, { title: string; links: Set<string> }>;
type Spikes = Map<string, { short: string; blocks: string; fallback: string }>;

function parseAdrs(): Adrs {
  const text = read("plan/decisions.md");
  const adrs: Adrs = new Map();
  for (const m of text.matchAll(/^## ADR-(\d+): (.+?)\n(.*?)(?=^## ADR-|(?![\s\S]))/gms)) {
    const [, n = "", rawTitle = "", body = ""] = m;
    const title = rawTitle.trim();
    if (title.startsWith("replaced by")) continue;
    const links = new Set([...body.matchAll(/\]\(\.\.\/specs\/([a-z-]+)\.md/g)].map((l) => l[1] ?? ""));
    adrs.set(n, { title: title.replace(/\.+$/, ""), links });
  }
  return adrs;
}

function parseSpikes(): Spikes {
  const openPart = read("plan/open-questions.md").split("## Resolved")[0] ?? "";
  const spikes: Spikes = new Map();
  for (const m of openPart.matchAll(/^\| SPIKE-(\d+) \|(.*)\|[^\S\n]*$/gm)) {
    const [, n = "", rest = ""] = m;
    const cols = rest.split(" | ").map((c) => c.trim());
    if (cols.length < 4) continue;
    const [question = "", blocks = "", , fallback = ""] = cols;
    const short = question.replace(/\s+/g, " ").replace(/[ .]+$/, "");
    spikes.set(n, { short, blocks: blocks.replaceAll("**", ""), fallback: fallback.replace(/[ |]+$/, "") });
  }
  return spikes;
}

function parseJourneys(): Map<string, string[]> {
  const text = read("product/user-journeys.md");
  const bySpec = new Map<string, string[]>();
  for (const m of text.matchAll(/^\| (\w+) \| (.+?) \| (.+?) \|[^\S\n]*$/gm)) {
    const [, num = "", , links = ""] = m;
    if (num === "#" || /^-+$/.test(num)) continue;
    for (const s of new Set([...links.matchAll(/\(\.\.\/specs\/([a-z-]+)\.md/g)].map((l) => l[1] ?? ""))) {
      bySpec.set(s, [...(bySpec.get(s) ?? []), num]);
    }
  }
  return bySpec;
}

function boxFor(spec: string, adrs: Adrs, spikes: Spikes, journeys: Map<string, string[]>): string {
  const body = stripBox(read(`specs/${spec}.md`));
  const lines = [
    START,
    "> **Before you build from this spec** (generated by `scripts/docs-context.ts` from the decisions, roadmap, open questions and user journeys; don't edit by hand)",
  ];
  lines.push(`> - **Milestone:** ${MILESTONES[spec] ?? "see [roadmap](../plan/roadmap.md)"}.`);
  const refs = new Set([...body.matchAll(/(?:DECISION|ADR)-(\d+)/g)].map((m) => m[1] ?? ""));
  const applicable = [
    ...new Set([
      ...[...refs].filter((n) => adrs.has(n)),
      ...[...adrs].filter(([, a]) => a.links.has(spec)).map(([n]) => n),
    ]),
  ].sort(byNumber);
  if (applicable.length) {
    lines.push(
      `> - **Decisions that apply** ([decisions](../plan/decisions.md)): ${applicable.map((n) => `ADR-${n} ${adrs.get(n)?.title}`).join("; ")}.`,
    );
  }
  const used = [...new Set([...body.matchAll(/SPIKE-(\d+)/g)].map((m) => m[1] ?? ""))]
    .filter((n) => spikes.has(n))
    .sort(byNumber);
  if (used.length) {
    lines.push(
      "> - **Open questions** ([open questions](../plan/open-questions.md)); build the part that depends on one only after it's resolved, or use its fallback:",
    );
    for (const n of used) {
      const s = spikes.get(n);
      if (s) lines.push(`>   - **SPIKE-${n}** (${s.blocks}): ${s.short} *If no:* ${s.fallback}`);
    }
  } else {
    lines.push("> - **Open questions:** none.");
  }
  const j = journeys.get(spec);
  if (j) {
    lines.push(
      `> - **User journeys served** ([user journeys](../product/user-journeys.md)): steps ${j.join(", ")}. A change here must keep those steps working.`,
    );
  }
  lines.push(END);
  return `${lines.join("\n")}\n\n`;
}

/** Brings every box up to date (or only reports, with `check`). A spec with no milestone entry stops it before any box is checked. */
export function updateBoxes(check: boolean): { stale: string[]; count: number; missing: string[] } {
  const specs = readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
  const missing = specs.filter((s) => !(s in MILESTONES));
  if (missing.length) return { stale: [], count: specs.length, missing };
  const adrs = parseAdrs();
  const spikes = parseSpikes();
  const journeys = parseJourneys();
  const stale: string[] = [];
  for (const spec of specs) {
    const text = read(`specs/${spec}.md`);
    const stripped = stripBox(text);
    const nl = stripped.indexOf("\n");
    const title = nl < 0 ? stripped : stripped.slice(0, nl);
    const rest = nl < 0 ? "" : stripped.slice(nl + 1);
    const updated = `${title}\n\n${boxFor(spec, adrs, spikes, journeys)}${rest.replace(/^\n+/, "")}`;
    if (updated !== text) {
      stale.push(spec);
      if (!check) writeFileSync(join(SPEC_DIR, `${spec}.md`), updated);
    }
  }
  return { stale, count: specs.length, missing };
}

if (import.meta.main) {
  const check = Bun.argv.includes("--check");
  const { stale, count, missing } = updateBoxes(check);
  if (missing.length) {
    console.log(`No milestone entry for: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (check && stale.length) {
    console.log(`Out-of-date 'Before you build' boxes: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`${check ? "checked" : "updated"} ${count} specs; ${stale.length} changed`);
}
