// Headless and global argument parsing (tui "Headless mode", cli-config "Commands").
export type OutputFormat = "text" | "json" | "stream-json";

export type HeadlessArgs = {
  print: boolean;
  prompt?: string;
  output: OutputFormat;
  offline: boolean;
  noSessionPersistence: boolean;
  resume?: string;
  continued: boolean;
  repair: boolean;
  fork?: boolean;
  budget?: number;
  maxRequests?: number;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode?: string;
  model?: string;
  provider?: string;
  effort?: string;
};

export type ParseResult = (HeadlessArgs | { error: string; exitCode: 2 }) & Record<string, unknown>;

const OUTPUTS = ["text", "json", "stream-json"] as const;

function fail(message: string): ParseResult {
  return { error: message, exitCode: 2 };
}

function need(argv: readonly string[], i: number, flag: string): string | ParseResult {
  const v = argv[i + 1];
  if (
    v === undefined ||
    (v.startsWith("-") && v.length > 1 && flag !== "--allowedTools" && flag !== "--disallowedTools")
  )
    return fail(`${flag} needs a value`);
  return v;
}

/** Parses headless-relevant flags; unknown flags are usage errors (exit 2). */
export function parseHeadlessArgs(argv: readonly string[]): ParseResult {
  const out: HeadlessArgs = {
    print: false,
    output: "text",
    offline: false,
    noSessionPersistence: false,
    continued: false,
    repair: false,
    fork: false,
    allowedTools: [],
    disallowedTools: [],
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-p" || a === "--print") {
      out.print = true;
      const next = argv[i + 1];
      if (next !== undefined && !(next.startsWith("-") && next.length > 1)) {
        out.prompt = next;
        i += 1;
      }
    } else if (a === "--offline") out.offline = true;
    else if (a === "--no-session-persistence") out.noSessionPersistence = true;
    else if (a === "--continue" || a === "-c") out.continued = true;
    else if (a === "--repair") out.repair = true;
    else if (a === "--fork") out.fork = true;
    else if (a === "--output") {
      const v = need(argv, i, a);
      if (typeof v !== "string") return v;
      if (!(OUTPUTS as readonly string[]).includes(v))
        return fail(`--output must be text, json or stream-json (got "${v}")`);
      out.output = v as OutputFormat;
      i += 1;
    } else if (a === "--resume" || a === "-r") {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next.length > 1)) {
        out.continued = true;
      } else {
        out.resume = next;
        i += 1;
      }
    } else if (a === "--budget") {
      const v = need(argv, i, a);
      if (typeof v !== "string") return v;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return fail(`--budget must be a non-negative number (got "${v}")`);
      out.budget = n;
      i += 1;
    } else if (a === "--max-requests") {
      const v = need(argv, i, a);
      if (typeof v !== "string") return v;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) return fail(`--max-requests must be a positive integer (got "${v}")`);
      out.maxRequests = n;
      i += 1;
    } else if (a === "--allowedTools" || a === "--disallowedTools") {
      const v = need(argv, i, a);
      if (typeof v !== "string") return v;
      (a === "--allowedTools" ? out.allowedTools : out.disallowedTools).push(v);
      i += 1;
    } else if (a === "--permission-mode" || a === "--model" || a === "--provider" || a === "--effort") {
      const v = need(argv, i, a);
      if (typeof v !== "string") return v;
      if (a === "--permission-mode") out.permissionMode = v;
      else if (a === "--model") out.model = v;
      else if (a === "--provider") out.provider = v;
      else out.effort = v;
      i += 1;
    } else if (a === "--dangerously-skip-permissions") {
      out.permissionMode = "bypassPermissions";
    } else if (a.startsWith("-") && a.length > 1) {
      return fail(`unknown flag "${a}"`);
    } else {
      positionals.push(a);
    }
  }
  const first = positionals[0];
  if (out.prompt === undefined && first !== undefined) out.prompt = first;
  return out;
}
