import type { AbsPath } from "../../schema/index.ts";
import type { Decision, Request } from "../decide/index.ts";

/** What a call does, derived from the checks that ran on it (permissions §0b); the prompt and `suggestGrant` read it. */
export type Effects = {
  writes: "workspace" | "outside" | "protected" | "none" | "unknown";
  network: "none" | "allowed-hosts" | { newHosts: string[] } | "unknown";
  sensitiveReads: AbsPath[];
  remote: Array<"push" | "publish" | "upload" | "deploy" | "destructive-mcp">;
  sandboxed: boolean;
};

export function effectsOf(req: Request, decision: Decision, sandboxed: boolean): Effects {
  const { findings } = decision;
  const a = req.action;
  const remote = [
    ...new Set(findings.flatMap((f) => (f.remote === undefined ? [] : [f.remote as Effects["remote"][number]]))),
  ];
  const sensitiveReads = [
    ...new Set(
      findings.flatMap((f) => (f.kind === "sensitive" && f.access === "read" && f.path ? [f.path as AbsPath] : [])),
    ),
  ];
  const base = { sensitiveReads, remote, sandboxed };
  const placed = (): Effects["writes"] =>
    findings.some((f) => f.kind === "protected")
      ? "protected"
      : findings.some((f) => f.access === "edit" && f.kind === "outside")
        ? "outside"
        : "workspace";
  switch (a.kind) {
    case "read":
    case "interaction":
    case "task-list":
      return { ...base, writes: "none", network: "none" };
    case "edit":
      return { ...base, writes: placed(), network: "none" };
    case "network":
      return {
        ...base,
        writes: "none",
        network: decision.rule?.behavior === "allow" ? "allowed-hosts" : { newHosts: [a.host] },
      };
    case "shell": {
      const subs = a.analysis.commands;
      if (a.analysis.understood && subs?.every((s) => s.readOnly === true) === true)
        return { ...base, writes: "none", network: "none" };
      if (!sandboxed) {
        const writes = findings.some((f) => f.kind === "protected") ? "protected" : "unknown";
        return { ...base, writes, network: "unknown" };
      }
      return { ...base, writes: a.analysis.understood ? placed() : "unknown", network: "allowed-hosts" };
    }
  }
}
