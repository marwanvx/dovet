import type { Behavior } from "../rules/index.ts";
import { analyzeShell } from "../shell-parse/analyze.ts";
import { expandGlob, isDirectory } from "../shell-parse/glob.ts";
import type { ShellParsers } from "../shell-parse/load.ts";
import { type Action, decide, type State } from "./decide.ts";

export type { Action, Decision, Finding, FindingKind, Request, State } from "./decide.ts";
export { decide } from "./decide.ts";
export type { Env } from "./paths.ts";

/** A `permissions.examples` decider that runs the built-in checks; shell examples count as sandboxed when auto-allow is on. */
export function exampleDecider(st: State, parsers: ShellParsers) {
  return (tool: string, value: string, cwd: string): { behavior: Behavior; by: string } | undefined => {
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
      action = { kind: "shell", analysis, sandboxed: st.sandboxAutoAllow === true };
    } else if (tool === "Read" || tool === "Edit") action = { kind: tool === "Read" ? "read" : "edit", paths: [value] };
    else if (tool === "WebFetch")
      action = { kind: "network", host: URL.canParse(value) ? new URL(value).hostname : value };
    else return undefined;
    const d = decide({ tool, action }, { ...st, env });
    return { behavior: d.behavior, by: d.by };
  };
}
