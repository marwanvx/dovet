// A headless run with a scripted model, shared by the M2 exit-check fixtures.
import { join } from "node:path";
import { runHeadless } from "../../src/cli/headless-run.ts";
import type { Os } from "../../src/platform/index.ts";
import type { LoadedSettings, LoadInput } from "../../src/store/index.ts";
import { builtinTools, type ToolDefinition } from "../../src/tools/index.ts";
import { fakePlatform, sequentialIds } from "../helpers/index.ts";

export const testOs = (): Os =>
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
export const fileTools: ToolDefinition<unknown>[] = builtinTools.filter((t) =>
  ["Read", "Write", "Edit"].includes(t.name),
);

export type Call = { name: string; input: unknown };

/** One reply per request: the calls to make, or the closing text when the list is empty. */
export function scripted(script: Call[][], onRequest?: (n: number) => void, delayMs = 0, closing = "done") {
  let next = 0;
  return {
    render: () => ({ provider: "nvidia", package: "x", modelId: "m", messages: [], tools: [], providerOptions: {} }),
    stream: async function* () {
      onRequest?.(next);
      if (delayMs > 0) await Bun.sleep(delayMs);
      const calls = script[next++] ?? [];
      yield {
        type: "done",
        stopReason: calls.length > 0 ? "tool_use" : "end_turn",
        stored: {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "x",
          packageVersion: "1",
          modelId: "m",
          parts: [
            ...calls.map((c, i) => ({
              kind: "tool_call" as const,
              id: `c${next}-${i}`,
              name: c.name,
              inputJson: JSON.stringify(c.input),
            })),
            ...(calls.length === 0 ? [{ kind: "text" as const, text: closing }] : []),
          ],
          usage: { promptTokens: 100, completionTokens: 10 },
          finishReason: "stop",
        },
      };
    },
  } as never;
}

export type RunOver = {
  adapter: ReturnType<typeof scripted>;
  mode?: string;
  resume?: string;
  repair?: boolean;
  prompt?: string;
  settings?: Record<string, unknown>;
  home?: string;
  ids?: string;
  /** The writer lock names this process; a test that kills a child needs the real one. */
  pid?: number;
  host?: string;
  contextWindow?: number;
};

export function runIn(root: string, over: RunOver) {
  const home = over.home ?? join(root, "home");
  const env = { NVIDIA_API_KEY: "nvapi-FAKE", HOME: home };
  const settings = {
    settings: { provider: "nvidia", model: "test/model", ...over.settings },
    rules: { allow: [], ask: [], deny: [] },
    warnings: [],
    notices: [],
    files: [],
    untrusted: [],
  } as unknown as LoadedSettings;
  const loadInput: LoadInput = {
    dirs: { config: join(root, "cfg") },
    home,
    projectRoot: root,
    env,
    trust: { project: true, local: true },
  };
  const data = join(root, "data");
  return runHeadless({
    dirs: { config: join(root, "cfg"), data, cache: join(root, "cache") },
    projectRoot: root,
    cwd: root,
    os: testOs(),
    settings,
    env,
    loadInput,
    args: {
      print: true,
      output: "text",
      offline: false,
      noSessionPersistence: false,
      continued: false,
      repair: over.repair ?? false,
      allowedTools: [],
      disallowedTools: [],
      ...(over.mode === undefined ? {} : { permissionMode: over.mode }),
      ...(over.resume === undefined ? {} : { resume: over.resume }),
    },
    prompt: over.prompt ?? "go",
    clock: { now: () => Date.now() },
    ids: sequentialIds(over.ids ?? "C"),
    pid: over.pid ?? 1,
    host: over.host ?? "h",
    platform: fakePlatform({ os: testOs() }),
    contextWindow: over.contextWindow ?? 10_000,
    toolDefs: fileTools,
    adapter: over.adapter,
  } as never);
}
