// Policy helpers for built-in tools (M1-23c): `describeAction` effects from `effectsOf`, the silent read.

import type { Request, State } from "../policy/index.ts";
import { analyzeShell, decide, effectsOf, expandGlob, isDirectory, isExcludedCommand } from "../policy/index.ts";
import type { AbsPath } from "../schema/index.ts";
import type { Effects, ToolContext, ToolPolicyState } from "./types.ts";

const FALLBACK_READ: Effects = { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false };
const FALLBACK_EDIT: Effects = {
  writes: "unknown",
  network: "none",
  sensitiveReads: [],
  remote: [],
  sandboxed: false,
};
const FALLBACK_SHELL: Effects = {
  writes: "unknown",
  network: "unknown",
  sensitiveReads: [],
  remote: [],
  sandboxed: false,
};

function stateOf(policy: ToolPolicyState): State {
  return {
    mode: policy.mode,
    rules: policy.rules,
    env: policy.env,
    ...(policy.sandboxAutoAllow === undefined ? {} : { sandboxAutoAllow: policy.sandboxAutoAllow }),
    ...(policy.tainted === undefined ? {} : { tainted: policy.tainted }),
    ...(policy.taintSource === undefined ? {} : { taintSource: policy.taintSource }),
    ...(policy.defaultBranch === undefined ? {} : { defaultBranch: policy.defaultBranch }),
    ...(policy.blockReadsOutsideWorkingDirectories === undefined
      ? {}
      : { blockReadsOutsideWorkingDirectories: policy.blockReadsOutsideWorkingDirectories }),
  };
}

/** Effects for a file read or edit via the decision; falls back when no policy is wired (unit tests). */
export function fileEffects(ctx: ToolContext, kind: "read" | "edit", paths: AbsPath[]): Effects {
  const policy = ctx.policy;
  if (policy === undefined || paths.length === 0) return kind === "read" ? FALLBACK_READ : FALLBACK_EDIT;
  try {
    const req: Request = { tool: kind === "read" ? "Read" : "Edit", action: { kind, paths: [...paths] } };
    const st = stateOf(policy);
    return effectsOf(req, decide(req, st), false);
  } catch {
    return kind === "read" ? FALLBACK_READ : FALLBACK_EDIT;
  }
}

/** Effects for a shell command via analysis, the decision and `effectsOf`; fail-closed without parsers. */
export function shellEffects(
  ctx: ToolContext,
  shell: "bash" | "powershell",
  command: string,
  unsandboxedRetry: boolean,
): Effects {
  const policy = ctx.policy;
  const allowUnsandboxed = ctx.settings.sandbox?.allowUnsandboxedCommands !== false;
  const tool = shell === "bash" ? ("Bash" as const) : ("PowerShell" as const);
  const excluded = isExcludedCommand(command, ctx.settings.sandbox?.excludedCommands ?? [], tool) && allowUnsandboxed;
  const retry = unsandboxedRetry && allowUnsandboxed;
  const svc = ctx.sandbox;
  const healthy =
    ctx.settings.sandbox?.enabled === false
      ? false
      : svc === undefined
        ? policy?.sandboxed === true
        : svc.state === "on" || svc.state === "weak" || svc.state === "experimental";
  const sandboxed = healthy && !retry && !excluded;
  if (policy === undefined || policy.parsers === undefined) return { ...FALLBACK_SHELL, sandboxed };
  try {
    const analysis = analyzeShell(policy.parsers, shell, command, {
      cwd: policy.env.cwd,
      workingDirs: [...policy.env.workingDirs],
      home: policy.env.home,
      glob: expandGlob,
      isDirectory,
    });
    const req: Request = {
      tool: shell === "bash" ? "Bash" : "PowerShell",
      action: { kind: "shell", analysis, sandboxed },
      input: { command, dangerouslyDisableSandbox: unsandboxedRetry },
    };
    return effectsOf(req, decide(req, stateOf(policy)), sandboxed);
  } catch {
    return { ...FALLBACK_SHELL, sandboxed };
  }
}

/** Whether reading needs no prompt: the decision allows it in both spellings (§3.3, §4.2). */
export function canReadWithoutPrompt(ctx: ToolContext, paths: readonly string[]): boolean {
  const policy = ctx.policy;
  if (policy === undefined || paths.length === 0) return false;
  try {
    const req: Request = { tool: "Read", action: { kind: "read", paths: [...paths] } };
    return decide(req, stateOf(policy)).behavior === "allow";
  } catch {
    return false;
  }
}
