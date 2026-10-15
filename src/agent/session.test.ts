import { describe, expect, test } from "bun:test";
import { fakeClock, fakePlatform, sequentialIds, tempProject } from "../../test/helpers/index.ts";
import { createRuntime, type RuntimeDeps } from "./runtime.ts";
import type { SessionImpl } from "./session.ts";

function deps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    clock: fakeClock(),
    ids: sequentialIds(),
    platform: fakePlatform(),
    dirs: { config: "/cfg", data: "/data", cache: "/cache" },
    env: {},
    stdio: { isTTY: true },
    ...overrides,
  };
}

describe("two sessions in one process", () => {
  // spec: interfaces §9 (two sessions in one process share no state)
  test("interleaved turns share no state", async () => {
    const runtime = createRuntime(deps());
    const a = await tempProject({ "a.ts": "a" });
    const b = await tempProject({ "b.ts": "b" });
    try {
      const s1 = (await runtime.openSession({ cwd: a.root as never, interactive: true, overrides: {} })) as SessionImpl;
      const s2 = (await runtime.openSession({ cwd: b.root as never, interactive: true, overrides: {} })) as SessionImpl;
      expect(s1.id).not.toBe(s2.id);

      s1.submit({ text: "first", attachments: [] });
      const s2Seen: string[] = [];
      const sub = (async () => {
        for await (const e of s2.events()) {
          s2Seen.push(e.type);
          if (e.type === "status") break;
        }
      })();
      await sub;
      expect(s2Seen).toEqual(["status"]);

      await s1.command({ name: "plan", args: "fix login" });
      expect(s1.planPath).toBeDefined();
      expect(s2.planPath).toBeUndefined();
      expect(s1.toolContext().session.mode).toBe("plan");
      expect(s2.toolContext().session.mode).toBe("default");

      s1.applyEffects([{ kind: "set-mode", mode: "default" }]);
      expect(s1.toolContext().session.mode).toBe("default");

      s1.answerPermission("00000000000000000000000000" as never, { decision: "no" });
      s2.answerQuestion("00000000000000000000000000" as never, { dismissed: true });
      expect(await s1.command({ name: "nope", args: "" })).toEqual({
        ok: false,
        error: "Unknown command /nope",
      });

      await s1.close();
      await s2.close();
      await s1.close();
    } finally {
      await a.dispose();
      await b.dispose();
      await runtime.close();
    }
  });

  // spec: AC-TOOLS-50
  test("headless omits AskUserQuestion via the session's declared tools", async () => {
    const runtime = createRuntime(deps());
    try {
      const headless = (await runtime.openSession({
        cwd: "/tmp" as never,
        interactive: false,
        overrides: {},
      })) as SessionImpl;
      const interactive = (await runtime.openSession({
        cwd: "/tmp" as never,
        interactive: true,
        overrides: {},
      })) as SessionImpl;
      expect(headless.declaredTools()).not.toContain("AskUserQuestion");
      expect(interactive.declaredTools()).toContain("AskUserQuestion");
      const first: string[] = [];
      for await (const e of headless.events()) {
        first.push(e.type);
        break;
      }
      expect(first).toEqual(["status"]);
      await headless.close();
      await interactive.close();
    } finally {
      await runtime.close();
    }
  });

  test("a question can be answered through the session's request id", async () => {
    const runtime = createRuntime(deps());
    try {
      const s = (await runtime.openSession({ cwd: "/tmp" as never, interactive: true, overrides: {} })) as SessionImpl;
      const ctx = s.toolContext();
      const asked = ctx.interact?.askQuestions(
        {
          questions: [
            {
              question: "Q?",
              header: "H",
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
              multiSelect: false,
            },
          ],
        },
        new AbortController().signal,
      );
      if (asked === undefined) throw new Error("no interact");
      const pending = (s as unknown as { pending: Map<string, unknown> }).pending;
      const requestId = [...pending.keys()][0] as never;
      if (requestId === undefined) throw new Error("no request id");
      s.answerQuestion(requestId, { answers: [{ selected: ["A"], notes: [] }] });
      await expect(asked).resolves.toEqual({ answers: [{ selected: ["A"], notes: [] }] });
      await s.close();
    } finally {
      await runtime.close();
    }
  });

  test("/plan shows the written plan and open returns its path", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "dovet-plan-cmd-"));
    const data = await mkdtemp(join(tmpdir(), "dovet-data-"));
    const runtime = createRuntime(deps({ dirs: { config: data as never, data: data as never, cache: data as never } }));
    try {
      const s = (await runtime.openSession({ cwd: dir as never, interactive: true, overrides: {} })) as SessionImpl;
      await s.command({ name: "plan", args: "first" });
      const plan = s.planPath as string;
      await mkdir(dirname(plan), { recursive: true });
      await writeFile(plan, "# Shown\nplan body\n");
      const shown = await s.command({ name: "plan", args: "" });
      expect(shown.ok && shown.output).toContain("plan body");
      const opened = await s.command({ name: "plan", args: "open" });
      expect(opened.ok && opened.output).toBe(plan);
      await s.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await runtime.close();
    }
  });
});
