// The rendered system prompt (context §2, prompts/README.md "How the system prompt is assembled").
import type { GitHead } from "../../platform/index.ts";
import type { PermissionMode } from "../../schema/index.ts";
import { escapeReservedMarkers } from "./markers.ts";
import { prompt } from "./prompts.ts";

export type PromptState = {
  /** `auto` has no prompt text yet (v0.2). */
  mode: Exclude<PermissionMode, "auto">;
  planFile?: string;
  sandbox: boolean;
  headless: boolean;
  webSearch: boolean;
  attribution: "none" | "trailer";
  /** The model's display name, used in the attribution trailer. */
  modelName: string;
};

export type EnvironmentFacts = {
  os: string;
  shellTool: string;
  workspaceRoot: string;
  git: GitHead | null;
  /** `YYYY-MM-DD`, the local date at session start (`sessionDate`). */
  date: string;
  model: string;
  provider: string;
};

export type InstructionText = { displayPath: string; content: string };

/** The mode text, shared by the system prompt and the mode-change instruction. */
export function modeText(mode: PromptState["mode"], planFile?: string): string {
  const text = prompt(`modes/${mode}.md`);
  if (mode !== "plan") return text;
  if (planFile === undefined) throw new Error("plan mode needs the plan file path");
  return text.replaceAll("<plan file>", () => planFile);
}

export function sandboxText(on: boolean): string {
  return prompt(on ? "modes/sandbox-on.md" : "modes/sandbox-off.md");
}

export function sessionDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function environmentBlock(env: EnvironmentFacts): string {
  const git =
    env.git === null
      ? "no"
      : env.git.kind === "branch"
        ? `yes (branch at session start: ${env.git.name})`
        : `yes (detached at ${env.git.commit})`;
  return [
    "## Environment",
    `- OS: ${env.os}  Shell tool: ${env.shellTool}`,
    `- Workspace root: ${env.workspaceRoot}`,
    `- Git repository: ${git}`,
    `- Date at session start: ${env.date}`,
    `- Model: ${env.model} via ${env.provider}`,
  ].join("\n");
}

function projectInstructions(files: readonly InstructionText[]): string {
  const head =
    "## Project instructions\nThese come from instruction files in this project and the user's config. Follow them. Later files are more specific and take precedence.";
  const sections = files.map(
    (f) => `### ${escapeReservedMarkers(f.displayPath)}\n${escapeReservedMarkers(f.content.replace(/\r?\n$/, ""))}`,
  );
  return [head, ...sections].join("\n\n");
}

/** Pure: everything that varies comes in through the arguments, so the bytes are stable for the epoch. */
export function renderSystemPrompt(
  state: PromptState,
  env: EnvironmentFacts,
  instructions: readonly InstructionText[],
): string {
  const layers = [prompt("system.md"), modeText(state.mode, state.planFile), sandboxText(state.sandbox)];
  if (state.headless || state.mode === "dontAsk") layers.push(prompt("modes/headless.md"));
  if (state.webSearch) layers.push(prompt("conditional/websearch.md"));
  if (state.attribution === "trailer") {
    layers.push(prompt("conditional/git-attribution-trailer.md").replaceAll("<model>", () => state.modelName));
  }
  layers.push(environmentBlock(env));
  if (instructions.length > 0) layers.push(projectInstructions(instructions));
  return layers.join("\n\n");
}
