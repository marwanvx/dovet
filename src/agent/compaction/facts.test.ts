// The Dovet facts a compaction adds by code (context §6 procedure 3).
import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../../schema/index.ts";
import { collectFacts, renderFacts } from "./facts.ts";

let n = 0;
function ev(type: string, data: unknown, epoch = 0): EventEnvelope {
  n += 1;
  return {
    v: 1,
    id: `01J${String(n).padStart(23, "0")}`,
    ts: "2026-10-22T00:00:00.000Z",
    session: "01J00000000000000000000000",
    epoch,
    turn: 1,
    type,
    core: true,
    data,
  } as EventEnvelope;
}
const call = (callId: string, name: string, input: unknown) => ev("tool.call", { callId, name, raw: input, input });
const result = (callId: string, status: string, output: string) => ev("tool.result", { callId, status, output });
const change = (path: string, op: string, added = 1, removed = 0) =>
  ev("file.change", { path, op, added, removed, via: "Edit" });
const state = {
  mode: "default",
  tainted: [] as string[],
  grants: [] as string[],
  workingDirs: ["/work/app"],
  plan: null,
};

describe("files changed", () => {
  // spec: AC-CTX-12
  test("lists exactly the paths and operations of the file.change events", () => {
    const events = [
      change("/work/app/a.ts", "create", 10),
      change("/work/app/b.ts", "modify", 2, 1),
      change("/work/app/a.ts", "modify", 3, 2),
      change("/work/app/a.ts", "modify", 1, 1),
      change("/work/app/c.ts", "delete", 0, 5),
    ];
    const facts = collectFacts(events, state);
    expect(facts.filesChanged).toEqual([
      { path: "/work/app/a.ts", ops: ["create", "modify", "modify"], added: 14, removed: 3 },
      { path: "/work/app/b.ts", ops: ["modify"], added: 2, removed: 1 },
      { path: "/work/app/c.ts", ops: ["delete"], added: 0, removed: 5 },
    ]);
    const text = renderFacts(facts);
    expect(text).toContain("/work/app/a.ts: create, modify ×2 (+14 −3)");
    expect(text).toContain("/work/app/c.ts: delete (+0 −5)");
  });

  test("no changes says so", () => {
    expect(renderFacts(collectFacts([], state))).toContain("Files changed\n(none)");
  });
});

describe("commands and recent actions", () => {
  const run = (id: string, command: string, status: string, output: string) => [
    call(id, "Bash", { command }),
    result(id, status, output),
  ];

  test("keeps the last result of each distinct test or build command, not other commands", () => {
    const events = [
      ...run("c1", "bun test", "error", "1 fail"),
      ...run("c2", "ls -la", "ok", "files"),
      ...run("c3", "bun test", "ok", "all 9 pass"),
      ...run("c4", "bun run build", "ok", "built"),
    ];
    const facts = collectFacts(events, state);
    expect(facts.commands.map((c) => [c.command, c.status, c.output])).toEqual([
      ["bun test", "ok", "all 9 pass"],
      ["bun run build", "ok", "built"],
    ]);
  });

  // spec: AC-CTX-19
  test("lists the last 5 tool actions with their outcomes, oldest first", () => {
    const events = Array.from({ length: 7 }, (_, i) => [
      call(`k${i}`, "Read", { file_path: `/work/app/f${i}.ts` }),
      result(`k${i}`, i === 6 ? "error" : "ok", `body ${i}\nmore`),
    ]).flat();
    const facts = collectFacts(events, state);
    expect(facts.lastActions).toHaveLength(5);
    expect(facts.lastActions[0]).toBe("Read /work/app/f2.ts → ok: body 2");
    expect(facts.lastActions[4]).toBe("Read /work/app/f6.ts → error: body 6");
  });

  test("a call with no result is shown as having none", () => {
    const facts = collectFacts([call("z", "Bash", { command: "sleep 99" })], state);
    expect(facts.lastActions).toEqual(["Bash sleep 99 → no result"]);
  });
});

describe("task list, state and plan", () => {
  // spec: AC-CTX-19
  test("carries the latest TodoWrite list", () => {
    const todos1 = [{ content: "old", activeForm: "Old", status: "pending" }];
    const todos2 = [
      { content: "write tests", activeForm: "Writing tests", status: "completed" },
      { content: "ship", activeForm: "Shipping", status: "in_progress" },
    ];
    const events = [
      call("t1", "TodoWrite", { todos: todos1 }),
      result("t1", "ok", "Task list updated"),
      call("t2", "TodoWrite", { todos: todos2 }),
      result("t2", "ok", "Task list updated"),
    ];
    const text = renderFacts(collectFacts(events, state));
    expect(text).toContain("[x] write tests");
    expect(text).toContain("[~] ship");
    expect(text).not.toContain("[ ] old");
  });

  test("mode, taint, session grants, working directories and the plan", () => {
    const facts = collectFacts([], {
      mode: "plan",
      tainted: ["WebFetch https://example.com"],
      grants: ["Bash(bun test:*)"],
      workingDirs: ["/work/app", "/work/lib"],
      plan: { path: "/data/plans/p.md", text: "1. do it" },
    });
    const text = renderFacts(facts);
    expect(text).toContain("Permission mode: plan");
    expect(text).toContain("WebFetch https://example.com");
    expect(text).toContain("Bash(bun test:*)");
    expect(text).toContain("/work/lib");
    expect(text).toContain("/data/plans/p.md");
    expect(text).toContain("1. do it");
  });

  test("a plan file path without text names the file only", () => {
    const text = renderFacts(collectFacts([], { ...state, plan: { path: "/data/plans/p.md", text: null } }));
    expect(text).toContain("/data/plans/p.md");
  });
});
