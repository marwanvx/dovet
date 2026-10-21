// The Dovet facts a compaction adds by code, never by the model (context §6 procedure 3).
import { type EventEnvelope, FileChangeData, ToolCallData, ToolResultData } from "../../schema/index.ts";

export type FactsState = {
  mode: string;
  tainted: readonly string[];
  grants: readonly string[];
  workingDirs: readonly string[];
  plan: { path: string; text: string | null } | null;
};

export type DovetFacts = FactsState & {
  filesChanged: { path: string; ops: string[]; added: number; removed: number }[];
  commands: { command: string; status: string; output: string }[];
  lastActions: string[];
  tasks: { content: string; status: string }[] | null;
};

const SHELLS = new Set(["Bash", "PowerShell"]);
const TEST_OR_BUILD = /\b(test|tests|build|check|lint|typecheck|tsc|pytest|jest|vitest|compile|make)\b/i;
const LAST_ACTIONS = 5;
const MAX_COMMANDS = 10;

/** At most `n` code units, never ending inside a surrogate pair. */
function clip(text: string, n: number): string {
  if (text.length <= n) return text;
  const high = text.charCodeAt(n - 1) >= 0xd800 && text.charCodeAt(n - 1) <= 0xdbff;
  return `${text.slice(0, high ? n - 1 : n)}…`;
}

const firstLine = (text: string): string => clip((text.split("\n")[0] ?? "").trim(), 160);

function describeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
    if (typeof o[key] === "string") return clip(o[key], 200);
  }
  return clip(JSON.stringify(input), 120);
}

export function collectFacts(events: readonly EventEnvelope[], state: FactsState): DovetFacts {
  const files = new Map<string, DovetFacts["filesChanged"][number]>();
  const calls: { id: string; name: string; input: unknown }[] = [];
  const results = new Map<string, ToolResultData>();
  for (const e of events) {
    if (e.type === "file.change") {
      const c = FileChangeData.parse(e.data);
      const f = files.get(c.path) ?? { path: c.path, ops: [], added: 0, removed: 0 };
      f.ops.push(c.op);
      f.added += c.added;
      f.removed += c.removed;
      files.set(c.path, f);
    } else if (e.type === "tool.call") {
      const c = ToolCallData.parse(e.data);
      calls.push({ id: c.callId, name: c.name, input: c.input });
    } else if (e.type === "tool.result") {
      const r = ToolResultData.parse(e.data);
      results.set(r.callId, r);
    }
  }
  const commands = new Map<string, DovetFacts["commands"][number]>();
  for (const c of calls) {
    const command = (c.input as { command?: unknown } | null)?.command;
    const r = results.get(c.id);
    if (!SHELLS.has(c.name) || typeof command !== "string" || !TEST_OR_BUILD.test(command) || r === undefined) continue;
    commands.delete(command);
    commands.set(command, { command, status: r.status, output: r.output.trim().slice(-600) });
  }
  const todoCall = calls.findLast((c) => c.name === "TodoWrite" && results.get(c.id)?.status === "ok");
  const todos = (todoCall?.input as { todos?: { content: string; status: string }[] } | undefined)?.todos;
  return {
    ...state,
    filesChanged: [...files.values()],
    commands: [...commands.values()].slice(-MAX_COMMANDS),
    lastActions: calls.slice(-LAST_ACTIONS).map((c) => {
      const r = results.get(c.id);
      const head = `${c.name} ${describeInput(c.input)}`.trimEnd();
      if (r === undefined) return `${head} → no result`;
      const line = firstLine(r.output);
      return `${head} → ${r.status}${line === "" ? "" : `: ${line}`}`;
    }),
    tasks: todos === undefined ? null : todos.map((t) => ({ content: t.content, status: t.status })),
  };
}

function opsText(ops: readonly string[]): string {
  const runs: string[] = [];
  for (let i = 0; i < ops.length; ) {
    let j = i;
    while (ops[j] === ops[i]) j++;
    runs.push(j - i > 1 ? `${ops[i]} ×${j - i}` : (ops[i] ?? ""));
    i = j;
  }
  return runs.join(", ");
}

const MARK: Record<string, string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };

export function renderFacts(f: DovetFacts): string {
  const out: string[] = ["## Files changed"];
  if (f.filesChanged.length === 0) out.push("(none)");
  for (const c of f.filesChanged) out.push(`- ${c.path}: ${opsText(c.ops)} (+${c.added} −${c.removed})`);
  out.push("", "## Last result of each test or build command");
  if (f.commands.length === 0) out.push("(none)");
  for (const c of f.commands)
    out.push(`- \`${c.command}\` → ${c.status}`, ...c.output.split("\n").map((l) => `    ${l}`));
  out.push("", `## Your last ${LAST_ACTIONS} tool actions`);
  if (f.lastActions.length === 0) out.push("(none)");
  for (const a of f.lastActions) out.push(`- ${a}`);
  out.push("", "## Task list");
  if (f.tasks === null) out.push("(none)");
  else for (const t of f.tasks) out.push(`- ${MARK[t.status] ?? "[ ]"} ${t.content}`);
  out.push("", "## Session state", `Permission mode: ${f.mode}`);
  out.push(`Tainted by: ${f.tainted.length === 0 ? "(nothing)" : f.tainted.join("; ")}`);
  out.push(`Permissions granted for this session: ${f.grants.length === 0 ? "(none)" : f.grants.join("; ")}`);
  out.push(`Working directories: ${f.workingDirs.join("; ")}`);
  if (f.plan !== null) {
    out.push("", `## Plan file: ${f.plan.path}`);
    if (f.plan.text !== null) out.push(f.plan.text);
  }
  return out.join("\n");
}
