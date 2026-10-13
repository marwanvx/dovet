// Scenarios recorded live on NVIDIA by `bun run record` and replayed by the adapter tests (testing "Free test provider: NVIDIA").
import type { ToolDef } from "../../src/ai/index.ts";

export type Scenario = {
  name: string;
  model: string;
  systemText: string;
  tools: ToolDef[];
  user: string;
  /** Results for the first response's tool calls, in call order (cycled); when set, a second request follows. */
  results?: Array<{ output: string; isError: boolean }>;
};

const path = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};
const TOOLS: ToolDef[] = [
  { name: "read", description: "Read a text file and return its contents.", inputSchema: path },
  { name: "list", description: "List the files in a directory.", inputSchema: path },
];
const SYSTEM = "You are a terse coding assistant. Use the tools when the user asks about files.";
export const FIXTURE_MODEL = "z-ai/glm-5.3-flash";
export const MAX_TOKENS = 4096;

export const SCENARIOS: Scenario[] = [
  { name: "text", model: FIXTURE_MODEL, systemText: SYSTEM, tools: TOOLS, user: "Reply with the single word: ready" },
  {
    name: "parallel-tools",
    model: FIXTURE_MODEL,
    systemText: SYSTEM,
    tools: TOOLS,
    user: "Read README.md and package.json at the same time with two read calls, then tell me the project name.",
    results: [
      { output: "# demo-app\nA small demo.\n", isError: false },
      { output: "error: package.json not found", isError: true },
    ],
  },
];

export type Exchange = {
  request: { path: string; body: string };
  response: { status: number; contentType: string; body: string };
};
export type Fixture = { scenario: string; model: string; recorded: string; exchanges: Exchange[] };
