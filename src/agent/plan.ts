// The session's plan file and the instructions that tell the model its mode changed (tools §11; QUESTIONS Q85).
import { join } from "node:path";
import type { AbsPath, EventEnvelope, InstructionReason, PermissionMode } from "../schema/index.ts";
import { canonicalPlanFile, PLAN_FILE_KEY, planDir, projectPlanDir, type SessionLocation } from "../store/index.ts";
import { planFileFor, planSlug } from "../tools/index.ts";
import { escapeReservedMarkers, modeText, type PromptState } from "./transcript/index.ts";

/** A new plan file named after the words that started planning; in the session's own folder unless `plan.directory` is set and inside the project. */
export function newPlanFile(loc: SessionLocation, planDirectory: string | undefined, promptText: string): AbsPath {
  const slug = planSlug(promptText, loc.session.slice(-4).toLowerCase());
  const file =
    planDirectory !== undefined && planDirectory !== "" && projectPlanDir(loc, planDirectory) !== undefined
      ? planFileFor("", loc.projectRoot, planDirectory, slug)
      : (join(planDir(loc), `${slug}.md`) as AbsPath);
  return canonicalPlanFile(loc, file) as AbsPath;
}

export type PlanInstruction = {
  text: string;
  reason: Extract<InstructionReason, "mode-change" | "plan-approved" | "plan-reattach">;
};

/** The mode's text, and the approval when a plan file exists and plan mode is left (permissions §2: an explicit user act). */
export function modeChangeInstructions(
  from: PermissionMode,
  to: Exclude<PermissionMode, "auto">,
  planFile: string | undefined,
): PlanInstruction[] {
  const out: PlanInstruction[] = [{ text: modeText(to as PromptState["mode"], planFile), reason: "mode-change" }];
  if (from === "plan" && to !== "plan" && planFile !== undefined)
    out.push({ text: "The user approved the plan. Implement it now.", reason: "plan-approved" });
  return out;
}

/** The plan as the model sees it after a compaction-free break in its context, such as a fork's own copy. */
export function planReattach(path: string, content: string | null): PlanInstruction {
  return { text: `The current plan (${path}):\n${escapeReservedMarkers(content ?? "")}`, reason: "plan-reattach" };
}

/** A fork re-pointed the plan file and the model has not been told yet. */
export function forkedPlanUnannounced(events: readonly EventEnvelope[]): boolean {
  const last = events.findLast(
    (e) => e.type === "settings.change" && (e.data as { key?: unknown }).key === PLAN_FILE_KEY,
  );
  if (last === undefined || (last.data as { source?: unknown }).source !== "fork") return false;
  return !events
    .slice(events.lastIndexOf(last) + 1)
    .some((e) => e.type === "system.injected" && (e.data as { reason?: unknown }).reason === "plan-reattach");
}
