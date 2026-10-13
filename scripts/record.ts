// `bun run record [scenario]`: live NVIDIA fixtures whose follow-up requests are direct SDK replays (testing "Free test provider: NVIDIA").
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, type ModelMessage, streamText, type ToolSet, tool } from "ai";
import { sortTools } from "../src/ai/index.ts";
import { type Exchange, type Fixture, MAX_TOKENS, SCENARIOS, type Scenario } from "../test/helpers/nvidia-scenarios.ts";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const OUT = join(import.meta.dir, "..", "test", "fixtures", "nvidia");

function toolSet(s: Scenario): ToolSet {
  const sorted = sortTools(s.tools);
  return Object.fromEntries(
    sorted.map((d) => [d.name, tool({ description: d.description, inputSchema: jsonSchema(d.inputSchema) })]),
  );
}

async function record(s: Scenario, apiKey: string): Promise<Fixture> {
  // Only request bodies and response streams are saved; the key travels in a header, and no header is written.
  const exchanges: Exchange[] = [];
  const provider = createOpenAICompatible({
    name: "nvidia",
    baseURL: BASE_URL,
    apiKey,
    includeUsage: true,
    fetch: Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const res = await fetch(url, init);
        const body = await res.text();
        exchanges.push({
          request: { path: new URL(String(url)).pathname, body: String(init?.body) },
          response: { status: res.status, contentType: res.headers.get("content-type") ?? "", body },
        });
        return new Response(body, { status: res.status, headers: res.headers });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const step = async (messages: ModelMessage[]) => {
    const r = streamText({
      model: provider.chatModel(s.model),
      messages,
      tools: toolSet(s),
      maxRetries: 0,
      allowSystemInMessages: true,
      maxOutputTokens: MAX_TOKENS,
    });
    for await (const part of r.fullStream) if (part.type === "error") throw part.error;
    return (await r.response).messages;
  };

  const first: ModelMessage[] = [
    { role: "system", content: s.systemText },
    { role: "user", content: [{ type: "text", text: s.user }] },
  ];
  const answer = await step(first);
  if (s.results !== undefined) {
    const results = s.results;
    const calls = answer.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "tool-call") : [],
    );
    if (calls.length === 0)
      throw new Error(`${s.name}: the model made no tool call; record again or pick another model`);
    const toolMessage: ModelMessage = {
      role: "tool",
      content: calls.map((c, i) => {
        const r = results[i % results.length] ?? { output: "", isError: false };
        return {
          type: "tool-result" as const,
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          output: r.isError
            ? { type: "error-text" as const, value: r.output }
            : { type: "text" as const, value: r.output },
        };
      }),
    };
    await step([...first, ...answer, toolMessage]);
  }
  return { scenario: s.name, model: s.model, recorded: new Date().toISOString().slice(0, 10), exchanges };
}

const apiKey = process.env.NVIDIA_API_KEY;
if (!apiKey) {
  console.error("record: NVIDIA_API_KEY is not set (the free key from build.nvidia.com)");
  process.exit(2);
}
const wanted = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
for (const s of SCENARIOS.filter((x) => wanted.length === 0 || wanted.includes(x.name))) {
  const fixture = await record(s, apiKey);
  if (JSON.stringify(fixture).includes(apiKey)) throw new Error(`${s.name}: the key appears in the fixture; not saved`);
  writeFileSync(join(OUT, `${s.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`recorded ${s.name}: ${fixture.exchanges.length} request(s) on ${s.model}`);
}
