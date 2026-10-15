import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, loadRules, planExitChoices } from "../policy/index.ts";
import type { AbsPath } from "../schema/index.ts";
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  LEFT_WITHOUT_APPROVAL,
  NOT_APPROVED,
  NOT_IN_PLAN,
  planEdited,
  planFileFor,
  planSlug,
} from "./plan-mode.ts";
import { context, text } from "./test-context.ts";

describe("plan helpers", () => {
  test("slug removes placeholders and adds a suffix", () => {
    const slug = planSlug("Fix the login [Pasted text #1] [Image #2] flow", "ab12");
    expect(slug).not.toContain("[Pasted text");
    expect(slug).not.toContain("[Image");
    expect(slug.endsWith("-ab12")).toBe(true);
  });

  test("plan file defaults under session plans, or under plan.directory", () => {
    const sessionDir = "/data/sessions/s1" as never;
    const root = "/proj" as never;
    expect(planFileFor(sessionDir, root, undefined, "fix-login-ab12")).toBe(
      join("/data/sessions/s1", "plans", "fix-login-ab12.md"),
    );
    expect(planFileFor(sessionDir, root, "docs/plans", "fix-login-ab12")).toBe(
      join("/proj", "docs/plans", "fix-login-ab12.md"),
    );
  });
});

describe("EnterPlanMode", () => {
  // spec: AC-TOOLS-46
  test("needs no prompt and returns a set-mode effect", async () => {
    const tool = createEnterPlanModeTool();
    expect(tool.parallelSafe).toBe(false);
    const out = await tool.run(
      {},
      context("/tmp", {
        session: {
          id: "s",
          cwd: "/tmp" as never,
          workingDirs: ["/tmp" as never],
          mode: "default",
          taint: [],
          interactive: true,
        },
      }),
    );
    expect(out.status).toBe("ok");
    expect(out.meta?.effects).toEqual([{ kind: "set-mode", mode: "plan" }]);
  });
});

describe("ExitPlanMode", () => {
  // spec: AC-TOOLS-13
  test("each approve choice sets the right mode; No feedback reaches the model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-plan-"));
    try {
      const planFile = join(dir, "plan.md") as never;
      await writeFile(planFile, "# Plan\nDo things.\n");
      const answers = [
        { approve: "previous" as const, edited: false },
        { approve: "accept-edits" as const, edited: false },
        { approve: "manual" as const, edited: false },
      ];
      const expected = {
        previous: "bypassPermissions",
        "accept-edits": "acceptEdits",
        manual: "default",
      } as const;
      for (const answer of answers) {
        const tool = createExitPlanModeTool();
        const ctx = context(dir, {
          session: {
            id: "s",
            cwd: dir as never,
            workingDirs: [dir as never],
            mode: "plan",
            taint: [],
            interactive: true,
          },
          interact: {
            askQuestions: () => Promise.reject(new Error("unused")),
            presentPlan: () => Promise.resolve(answer),
          },
          planPreviousMode: "bypassPermissions",
          policy: {
            rules: { allow: [], ask: [], deny: [] } as never,
            mode: "plan",
            env: {
              os: "linux",
              home: dir,
              cwd: dir,
              workingDirs: [dir],
              canonicalize: (p: string) => p,
              pid: 1,
              ppid: 0,
              selfNames: [],
              planFile: planFile as string,
            },
          },
        });
        const out = await tool.run({}, ctx);
        expect(out.status).toBe("ok");
        const effect = out.meta?.effects?.find((e) => e.kind === "set-mode");
        expect(effect).toEqual({ kind: "set-mode", mode: expected[answer.approve] });
      }
      const tool = createExitPlanModeTool();
      const ctx = context(dir, {
        session: {
          id: "s",
          cwd: dir as never,
          workingDirs: [dir as never],
          mode: "plan",
          taint: [],
          interactive: true,
        },
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: () => Promise.resolve({ keepPlanning: "Try a smaller scope." }),
        },
        policy: {
          rules: { allow: [], ask: [], deny: [] } as never,
          mode: "plan",
          env: {
            os: "linux",
            home: dir,
            cwd: dir,
            workingDirs: [dir],
            canonicalize: (p: string) => p,
            pid: 1,
            ppid: 0,
            selfNames: [],
            planFile: planFile as string,
          },
        },
      });
      const out = await tool.run({}, ctx);
      expect(text(out)).toContain("Try a smaller scope.");
      expect(out.meta?.effects ?? []).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // spec: AC-TOOLS-46
  test("a plan written in the same response is the one shown; second exit errors with no dialog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-plan-"));
    try {
      const planFile = join(dir, "plan.md") as never;
      await writeFile(planFile, "# Fresh\nJust written.\n");
      let presented: { text: string; path: string } | undefined;
      const tool = createExitPlanModeTool();
      const ctx = context(dir, {
        session: {
          id: "s",
          cwd: dir as never,
          workingDirs: [dir as never],
          mode: "plan",
          taint: [],
          interactive: true,
        },
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: (plan) => {
            presented = plan;
            return Promise.resolve({ approve: "manual" as const, edited: false });
          },
        },
        policy: {
          rules: { allow: [], ask: [], deny: [] } as never,
          mode: "plan",
          env: {
            os: "linux",
            home: dir,
            cwd: dir,
            workingDirs: [dir],
            canonicalize: (p: string) => p,
            pid: 1,
            ppid: 0,
            selfNames: [],
            planFile: planFile as string,
          },
        },
      });
      await tool.run({}, ctx);
      expect(presented?.text).toContain("Just written");
      expect(await readFile(planFile, "utf8")).toContain("Just written");

      let dialoged = false;
      const second = createExitPlanModeTool();
      const ctx2 = context(dir, {
        session: {
          id: "s",
          cwd: dir as never,
          workingDirs: [dir as never],
          mode: "default",
          taint: [],
          interactive: true,
        },
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: () => {
            dialoged = true;
            return Promise.resolve({ approve: "manual" as const, edited: false });
          },
        },
        policy: {
          rules: { allow: [], ask: [], deny: [] } as never,
          mode: "default",
          env: {
            os: "linux",
            home: dir,
            cwd: dir,
            workingDirs: [dir],
            canonicalize: (p: string) => p,
            pid: 1,
            ppid: 0,
            selfNames: [],
            planFile: planFile as string,
          },
        },
      });
      const out2 = await second.run({}, ctx2);
      expect(out2.status).toBe("error");
      expect(text(out2)).toBe(NOT_IN_PLAN);
      expect(dialoged).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // spec: AC-TOOLS-46
  test("bypass previous is offered first; unchanged Ctrl+G is not marked edited", () => {
    expect(planExitChoices("bypassPermissions")[0]).toBe("bypassPermissions");
    expect(planExitChoices("plan")[0]).toBe("default");
    expect(planEdited(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(false);
    expect(planEdited(new Uint8Array([1]), new Uint8Array([2]))).toBe(true);
  });

  // spec: AC-TOOLS-46
  test("plan file writes auto-allow while other writes do not (touch prompts per decide.test)", async () => {
    const { tempProject } = await import("../../test/helpers/index.ts");
    const project = await tempProject({ "src/a.ts": "a" });
    try {
      const root = project.root;
      const plan = join(root, ".dovet", "plans", "p.md");
      const { canonicalizePath } = await import("../platform/index.ts");
      const os = process.platform as "linux" | "darwin" | "win32";
      const env = {
        os,
        home: root,
        cwd: root,
        workingDirs: [root],
        canonicalize: (p: string) => canonicalizePath(p, root, os),
        pid: 1,
        ppid: 0,
        selfNames: [] as readonly string[],
        planFile: plan,
        ownFiles: [join(root, ".dovet", "plans")] as readonly string[],
      };
      const rules = loadRules([], { os, home: root, canonicalize: (p: string) => p }).rules;
      const planDecision = decide(
        { tool: "Edit", action: { kind: "edit", paths: [plan] } },
        { mode: "plan", rules, env },
      );
      expect(planDecision.behavior).toBe("allow");
      const other = decide(
        { tool: "Edit", action: { kind: "edit", paths: [join(root, "src/a.ts")] } },
        { mode: "plan", rules, env },
      );
      expect(other.behavior).toBe("deny");
    } finally {
      await project.dispose();
    }
  });

  // spec: AC-TOOLS-46
  test("edited plans name the file; unchanged never claim edited; esc and mode-change end without approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-plan-"));
    try {
      const planFile = join(dir, "plan.md") as AbsPath;
      await writeFile(planFile, "# P\n");
      const basePolicy = {
        rules: { allow: [], ask: [], deny: [] } as never,
        mode: "plan" as const,
        env: {
          os: "linux" as const,
          home: dir,
          cwd: dir,
          workingDirs: [dir],
          canonicalize: (p: string) => p,
          pid: 1,
          ppid: 0,
          selfNames: [] as readonly string[],
          planFile: planFile as string,
        },
      };
      const baseSession = {
        id: "s",
        cwd: dir as never,
        workingDirs: [dir as never],
        mode: "plan" as const,
        taint: [] as readonly string[],
        interactive: true,
      };
      const tool = createExitPlanModeTool();
      const editedCtx = context(dir, {
        session: baseSession,
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: () => Promise.resolve({ approve: "manual" as const, edited: true }),
        },
        policy: basePolicy,
      });
      expect(text(await tool.run({}, editedCtx))).toContain(planFile);
      const cleanCtx = context(dir, {
        session: baseSession,
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: () => Promise.resolve({ approve: "manual" as const, edited: false }),
        },
        policy: basePolicy,
      });
      expect(text(await tool.run({}, cleanCtx))).not.toContain("edited");
      const escCtx = context(dir, {
        session: baseSession,
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: () => Promise.resolve({ dismissed: true as const, reason: "esc" as const }),
        },
        policy: basePolicy,
      });
      expect(text(await tool.run({}, escCtx))).toBe(NOT_APPROVED);
      const leftCtx = context(dir, {
        session: baseSession,
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: () => Promise.resolve({ dismissed: true as const, reason: "mode-changed" as const }),
        },
        policy: basePolicy,
      });
      expect(text(await tool.run({}, leftCtx))).toBe(LEFT_WITHOUT_APPROVAL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // spec: AC-TOOLS-46
  test("headless keeps plan mode and returns the plan without a dialog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-plan-"));
    try {
      const planFile = join(dir, "plan.md") as AbsPath;
      await writeFile(planFile, "# H\nheadless\n");
      let dialoged = false;
      const tool = createExitPlanModeTool();
      const ctx = context(dir, {
        session: {
          id: "s",
          cwd: dir as never,
          workingDirs: [dir as never],
          mode: "plan",
          taint: [],
          interactive: false,
        },
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: () => {
            dialoged = true;
            return Promise.resolve({ approve: "manual" as const, edited: false });
          },
        },
        policy: {
          rules: { allow: [], ask: [], deny: [] } as never,
          mode: "plan",
          env: {
            os: "linux",
            home: dir,
            cwd: dir,
            workingDirs: [dir],
            canonicalize: (p: string) => p,
            pid: 1,
            ppid: 0,
            selfNames: [],
            planFile: planFile as string,
          },
        },
      });
      const out = await tool.run({}, ctx);
      expect(out.status).toBe("ok");
      expect(text(out)).toContain("headless");
      expect(dialoged).toBe(false);
      expect(out.meta?.effects ?? []).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // spec: AC-TOOLS-46
  test("a plan passed inline is written first and shown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-plan-"));
    try {
      const planFile = join(dir, "inline.md") as AbsPath;
      let presented = "";
      const tool = createExitPlanModeTool();
      const ctx = context(dir, {
        session: {
          id: "s",
          cwd: dir as never,
          workingDirs: [dir as never],
          mode: "plan",
          taint: [],
          interactive: true,
        },
        interact: {
          askQuestions: () => Promise.reject(new Error("unused")),
          presentPlan: (p) => {
            presented = (p as { text: string }).text;
            return Promise.resolve({ approve: "manual" as const, edited: false });
          },
        },
        policy: {
          rules: { allow: [], ask: [], deny: [] } as never,
          mode: "plan",
          env: {
            os: "linux",
            home: dir,
            cwd: dir,
            workingDirs: [dir],
            canonicalize: (p: string) => p,
            pid: 1,
            ppid: 0,
            selfNames: [],
            planFile: planFile as string,
          },
        },
      });
      await tool.run({ plan: "# Inline\nwritten now\n" }, ctx);
      expect(await readFile(planFile, "utf8")).toContain("written now");
      expect(presented).toContain("written now");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // spec: AC-TOOLS-46
  test("empty and missing plans still show a dialog with empty text", async () => {
    for (const setup of ["empty", "missing"] as const) {
      const dir = await mkdtemp(join(tmpdir(), "dovet-plan-"));
      try {
        const planFile = join(dir, "plan.md") as AbsPath;
        if (setup === "empty") await writeFile(planFile, "");
        let seen = "unseen";
        const tool = createExitPlanModeTool();
        const ctx = context(dir, {
          session: {
            id: "s",
            cwd: dir as never,
            workingDirs: [dir as never],
            mode: "plan",
            taint: [],
            interactive: true,
          },
          interact: {
            askQuestions: () => Promise.reject(new Error("unused")),
            presentPlan: (p) => {
              seen = (p as { text: string }).text;
              return Promise.resolve({ keepPlanning: "Write it first." });
            },
          },
          policy: {
            rules: { allow: [], ask: [], deny: [] } as never,
            mode: "plan",
            env: {
              os: "linux",
              home: dir,
              cwd: dir,
              workingDirs: [dir],
              canonicalize: (p: string) => p,
              pid: 1,
              ppid: 0,
              selfNames: [],
              planFile: planFile as string,
            },
          },
        });
        const out = await tool.run({}, ctx);
        expect(seen).toBe("");
        expect(text(out)).toContain("Write it first.");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("EnterPlanMode is allowed without prompting in every mode", async () => {
    const { decide } = await import("../policy/index.ts");
    const { loadRules } = await import("../policy/index.ts");
    const rules = loadRules([], { os: "linux", home: "/h", canonicalize: (p: string) => p }).rules;
    const base = {
      os: "linux" as const,
      home: "/h",
      cwd: "/w",
      workingDirs: ["/w"],
      canonicalize: (p: string) => p,
      pid: 1,
      ppid: 0,
      selfNames: [] as readonly string[],
    };
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
      expect(
        decide({ tool: "EnterPlanMode", action: { kind: "task-list" } }, { mode, rules, env: base }).behavior,
      ).toBe("allow");
    }
  });
});
