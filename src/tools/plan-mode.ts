// Plan mode (tools §11): EnterPlanMode/ExitPlanMode with the plan file and PlanAnswer.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AbsPath, PermissionMode } from "../schema/index.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.ts";

export const NOT_IN_PLAN = "Not in plan mode. The plan was already approved; continue with the implementation.";
export const NOT_APPROVED = "The user hasn't approved the plan yet";
export const LEFT_WITHOUT_APPROVAL = "The user left plan mode without approving the plan";

const EnterInput = z.strictObject({});
type EnterInput = z.infer<typeof EnterInput>;

const ExitInput = z.strictObject({ plan: z.string().optional() });
type ExitInput = z.infer<typeof ExitInput>;

const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });
const ok = (text: string, effects?: ToolOutput["meta"]): ToolOutput => ({
  status: "ok",
  content: [{ kind: "text", text }],
  ...(effects === undefined ? {} : { meta: effects }),
});

function slugify(words: string): string {
  const cleaned = words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return cleaned === "" ? "plan" : cleaned;
}

export function planSlug(prompt: string, suffix: string): string {
  const withoutPlaceholders = prompt.replace(/\[Pasted text[^\]]*\]/gi, " ").replace(/\[Image[^\]]*\]/gi, " ");
  const words = withoutPlaceholders
    .split(/\s+/)
    .filter((w) => w !== "")
    .slice(0, 6)
    .join(" ");
  return `${slugify(words)}-${suffix}`;
}

export function planFileFor(
  sessionDir: string,
  projectRoot: string,
  planDirectory: string | undefined,
  slug: string,
): AbsPath {
  const file = `${slug}.md`;
  if (planDirectory !== undefined && planDirectory !== "") return join(projectRoot, planDirectory, file) as AbsPath;
  return join(sessionDir, "plans", file) as AbsPath;
}

export function planEdited(before: Uint8Array, after: Uint8Array): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) return true;
  return false;
}

function planPathOf(ctx: ToolContext): AbsPath | undefined {
  const fromPolicy = ctx.policy?.env.planFile;
  return fromPolicy as AbsPath | undefined;
}

function modeForApproval(
  approve: "previous" | "accept-edits" | "manual",
  previous: PermissionMode | undefined,
): PermissionMode {
  if (approve === "accept-edits") return "acceptEdits";
  if (approve === "manual") return "default";
  return previous ?? "default";
}

export function createEnterPlanModeTool(): ToolDefinition<EnterInput> {
  async function run(_input: EnterInput, _ctx: ToolContext): Promise<ToolOutput> {
    return ok("Entered plan mode.", { effects: [{ kind: "set-mode", mode: "plan" }] });
  }
  return {
    name: "EnterPlanMode",
    input: EnterInput,
    descriptionFile: "tools/EnterPlanMode.md",
    errorExample: {},
    parallelSafe: false,
    mutates: "none",
    describeAction(_input, _ctx) {
      return {
        kind: "task-list",
        effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
      };
    },
    run,
  };
}

export function createExitPlanModeTool(): ToolDefinition<ExitInput> {
  async function run(input: ExitInput, ctx: ToolContext): Promise<ToolOutput> {
    if (ctx.session.mode !== "plan") return fail(NOT_IN_PLAN);
    const path = planPathOf(ctx);
    if (path === undefined) return fail("No plan file for this session.");
    let text: string;
    if (input.plan !== undefined) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.plan, "utf8");
      text = input.plan;
    } else {
      try {
        text = await readFile(path, "utf8");
      } catch {
        text = "";
      }
    }
    if (!ctx.session.interactive) return ok(`Plan (headless):\n${text}\nFile: ${path}`);
    const interact = ctx.interact;
    if (interact === undefined) return fail(NOT_IN_PLAN);
    const answer = await interact.presentPlan({ text, path }, ctx.signal);
    if ("keepPlanning" in answer) return ok(answer.keepPlanning);
    if ("dismissed" in answer) {
      if (answer.reason === "mode-changed") return ok(LEFT_WITHOUT_APPROVAL);
      return ok(NOT_APPROVED);
    }
    const mode = modeForApproval(answer.approve, ctx.planPreviousMode);
    const body =
      answer.edited === true
        ? `The user edited the plan; the approved version is in ${path}`
        : `Plan approved. Continuing in ${mode}.`;
    return ok(body, { effects: [{ kind: "set-mode", mode }] });
  }

  return {
    name: "ExitPlanMode",
    input: ExitInput,
    descriptionFile: "tools/ExitPlanMode.md",
    errorExample: {},
    parallelSafe: false,
    mutates: "none",
    describeAction(_input, _ctx) {
      return {
        kind: "interaction",
        effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
      };
    },
    run,
  };
}

export const enterPlanModeTool = createEnterPlanModeTool();
export const exitPlanModeTool = createExitPlanModeTool();
