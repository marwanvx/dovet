import { PermissionMode } from "../../schema/index.ts";
import type { Behavior } from "../rules/index.ts";
import { analyzeShell } from "../shell-parse/analyze.ts";
import { expandGlob, isDirectory } from "../shell-parse/glob.ts";
import type { ShellParsers } from "../shell-parse/load.ts";
import { type Action, decide, type State } from "./decide.ts";

export type { Action, Decision, Finding, FindingKind, Request, State } from "./decide.ts";
export { decide, planExitChoices } from "./decide.ts";
export type { Env } from "./paths.ts";

/** A `permissions.examples` decider that runs the built-in checks; examples run in Manual mode with a healthy sandbox unless they name a mode. */
export function exampleDecider(st: State, parsers: ShellParsers) {
  return (tool: string, value: string, cwd: string, mode?: string): { behavior: Behavior; by: string } | undefined => {
    const env = { ...st.env, cwd };
    let action: Action;
    if (tool === "Bash" || tool === "PowerShell") {
      const analysis = analyzeShell(parsers, tool === "Bash" ? "bash" : "powershell", value, {
        cwd,
        workingDirs: env.workingDirs,
        home: env.home,
        glob: expandGlob,
        isDirectory,
      });
      action = { kind: "shell", analysis, sandboxed: true };
    } else if (tool === "Read" || tool === "Edit") action = { kind: tool === "Read" ? "read" : "edit", paths: [value] };
    else if (tool === "WebFetch")
      action = { kind: "network", host: URL.canParse(value) ? new URL(value).hostname : value };
    else return undefined;
    const named = PermissionMode.safeParse(mode === "manual" ? "default" : mode);
    const asked: State = { ...st, env, mode: named.success ? named.data : "default", sandboxAutoAllow: true };
    const d = decide({ tool, action }, asked);
    return { behavior: d.behavior, by: `${d.by}: ${d.reason}` };
  };
}
