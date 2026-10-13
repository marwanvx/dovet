// The one generic adapter over the AI SDK (providers "Model layer" and §1, interfaces §3).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  type AssistantModelMessage,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import { z } from "zod";
import pkg from "../../package.json";
import type { Part, Protocol, ReplayData, StoredResponse } from "../schema/index.ts";
import type { Secret } from "../store/index.ts";
import type {
  ProviderErrorInfo,
  ProviderRequest,
  RenderInput,
  SdkCall,
  StopReason,
  StreamEvent,
  ToolDef,
} from "./types.ts";

export type Endpoint = { package: string; baseURL: string; apiKey?: Secret };
export type FetchFunction = typeof fetch;
type ModelFactory = (call: SdkCall, endpoint: Endpoint, fetch: FetchFunction) => LanguageModel;

export type AdapterDeps = {
  /** The provider's endpoint from its registry record, with its resolved credential. */
  endpoint(provider: string): Endpoint;
  /** Replaces the package's own model, for scripted tests. */
  model?: ModelFactory;
};

const PROTOCOLS: Record<string, Protocol> = { "@ai-sdk/openai-compatible": "openai-chat" };
const VERSIONS: Record<string, string> = pkg.dependencies;
const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);
const ToolDefs = z.array(
  z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) }),
);

const defaultModel: ModelFactory = (call, endpoint, fetch) => {
  if (call.package !== "@ai-sdk/openai-compatible") throw new Error(`provider package ${call.package} is not bundled`);
  return createOpenAICompatible({
    name: call.provider,
    baseURL: endpoint.baseURL,
    ...(endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey.reveal() }),
    includeUsage: true,
    fetch,
  }).chatModel(call.modelId);
};

/** Records the exact request bytes before sending them (providers §6b); credentials never leave in the record. */
export function capturingFetch(onRequest: (req: ProviderRequest) => void, base: FetchFunction = fetch): FetchFunction {
  const capture = (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value;
    });
    const url = input instanceof Request ? input.url : String(input);
    onRequest({ url, headers, body, bodySha256: new Bun.CryptoHasher("sha256").update(body).digest("hex") });
    return base(input, init);
  };
  return Object.assign(capture, { preconnect: base.preconnect });
}

function mappedId(id: string): string {
  return `dovet_${new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 24)}`;
}

function stopReason(reason: string): StopReason {
  if (reason === "stop") return "end_turn";
  if (reason === "tool-calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content-filter") return "refusal";
  return { other: reason };
}

function statusKind(status: number): Pick<ProviderErrorInfo, "kind" | "retryable"> {
  if (status === 429) return { kind: "rate_limit", retryable: true };
  if (status === 503 || status === 529) return { kind: "overloaded", retryable: true };
  if (status >= 500) return { kind: "server", retryable: true };
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 402) return { kind: "billing", retryable: false };
  if (status === 404) return { kind: "not_found", retryable: false };
  if (status === 413) return { kind: "too_large", retryable: false };
  return { kind: "invalid_request", retryable: false };
}

export function classifyError(err: unknown): ProviderErrorInfo {
  if (APICallError.isInstance(err) && err.statusCode !== undefined) {
    const headers = err.responseHeaders ?? {};
    const retryAfter = Number(headers["retry-after"]);
    const requestId = headers["x-request-id"];
    return {
      ...statusKind(err.statusCode),
      ...(Number.isFinite(retryAfter) && headers["retry-after"] !== undefined
        ? { retryAfterMs: retryAfter * 1000 }
        : {}),
      status: err.statusCode,
      ...(requestId === undefined ? {} : { requestId }),
      message: err.message,
    };
  }
  if (err instanceof Error && err.name === "TimeoutError")
    return { kind: "timeout", retryable: true, message: err.message };
  if (err instanceof TypeError) return { kind: "network", retryable: true, message: err.message };
  return { kind: "unknown", retryable: false, message: err instanceof Error ? err.message : String(err) };
}

type StoredContext = { provider: string; package: string; packageVersion: string; modelId: string };

function replayOf(ctx: StoredContext, fields: Record<string, unknown> | undefined): ReplayData {
  const protocol = PROTOCOLS[ctx.package];
  if (protocol === undefined) throw new Error(`no protocol for ${ctx.package}`);
  return {
    provider: ctx.provider,
    protocol,
    modelId: ctx.modelId,
    fields: z.record(z.string(), z.json()).parse(fields ?? {}),
  };
}

/** Lossless: the step's SDK response messages → Dovet parts with replay data (providers §1). */
export function toStored(
  result: { messages: readonly ModelMessage[]; usage?: Record<string, unknown>; finishReason?: string },
  ctx: StoredContext,
): StoredResponse {
  const parts: Part[] = [];
  for (const message of result.messages) {
    if (message.role !== "assistant") throw new Error(`a model step returned a ${message.role} message`);
    if (message.providerOptions !== undefined) throw new Error("message-level provider options are not stored yet");
    const content =
      typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const p of content) {
      const opts = "providerOptions" in p ? p.providerOptions : undefined;
      const replay = opts === undefined ? {} : { replay: replayOf(ctx, opts) };
      if (p.type === "text") parts.push({ kind: "text", text: p.text, ...replay });
      else if (p.type === "reasoning") parts.push({ kind: "reasoning", summary: p.text, replay: replayOf(ctx, opts) });
      else if (p.type === "tool-call") {
        parts.push({
          kind: "tool_call",
          id: p.toolCallId,
          name: p.toolName,
          inputJson: JSON.stringify(p.input),
          ...replay,
        });
      } else throw new Error(`a model step returned a ${p.type} part, which Dovet doesn't store yet`);
    }
  }
  const protocol = PROTOCOLS[ctx.package];
  if (protocol === undefined) throw new Error(`no protocol for ${ctx.package}`);
  return { ...ctx, protocol, parts, usage: result.usage ?? {}, finishReason: result.finishReason ?? "" };
}

/** Stored parts → SDK messages; replay data only for the same provider and model, foreign call ids mapped (providers §1). */
export function fromStored(stored: StoredResponse, target: { provider: string; model: string }): ModelMessage[] {
  const sameProvider = stored.provider === target.provider;
  const same = sameProvider && stored.modelId === target.model;
  const id = (raw: string): string => (sameProvider ? raw : mappedId(raw));
  const content: Exclude<AssistantModelMessage["content"], string> = [];
  for (const p of stored.parts) {
    const opts =
      same && p.kind !== "reasoning" && "replay" in p && p.replay !== undefined
        ? { providerOptions: p.replay.fields as Record<string, Record<string, z.core.util.JSONType>> }
        : {};
    if (p.kind === "text") content.push({ type: "text", text: p.text, ...opts });
    else if (p.kind === "reasoning") {
      if (!same) continue;
      const fields = p.replay?.fields ?? {};
      content.push({
        type: "reasoning",
        text: p.summary ?? "",
        ...(Object.keys(fields).length > 0
          ? { providerOptions: fields as Record<string, Record<string, z.core.util.JSONType>> }
          : {}),
      });
    } else if (p.kind === "tool_call") {
      content.push({
        type: "tool-call",
        toolCallId: id(p.id),
        toolName: p.name,
        input: JSON.parse(p.inputJson),
        ...opts,
      });
    } else throw new Error(`an assistant turn can't hold a ${p.kind} part`);
  }
  return content.length === 0 ? [] : [{ role: "assistant", content }];
}

function toolSet(defs: readonly ToolDef[]): ToolSet {
  return Object.fromEntries(
    defs.map((d) => [d.name, tool({ description: d.description, inputSchema: jsonSchema(d.inputSchema) })]),
  );
}

export function createSdkAdapter(deps: AdapterDeps) {
  const makeModel = deps.model ?? defaultModel;

  /** Pure and deterministic: the same input gives identical call options. */
  function render(input: RenderInput): SdkCall {
    const { header } = input;
    const target = { provider: header.provider, model: header.model };
    const calls = new Map<string, { id: string; name: string }>();
    const messages: ModelMessage[] = [{ role: "system", content: header.systemText }];
    for (const item of input.transcript) {
      if (item.kind === "system") {
        messages.push({ role: "system", content: item.text });
      } else if (item.kind === "assistant") {
        const rendered = fromStored(item.stored, target);
        for (const p of item.stored.parts) {
          if (p.kind !== "tool_call") continue;
          const id = item.stored.provider === header.provider ? p.id : mappedId(p.id);
          calls.set(p.id, { id, name: p.name });
        }
        messages.push(...rendered);
      } else {
        const results = item.parts.flatMap((p) => (p.kind === "tool_result" ? [p] : []));
        if (results.length > 0) {
          messages.push({
            role: "tool",
            content: results.map((r) => {
              const call = calls.get(r.callId);
              if (call === undefined) throw new Error(`tool result ${r.callId} has no tool call before it`);
              const value = r.content.map((c) => (c.kind === "text" ? c.text : "")).join("");
              return {
                type: "tool-result",
                toolCallId: call.id,
                toolName: call.name,
                output: r.isError ? { type: "error-text", value } : { type: "text", value },
              };
            }),
          });
        }
        const rest = item.parts.flatMap((p) => {
          if (p.kind === "tool_result") return [];
          if (p.kind === "text" || p.kind === "instruction") return [{ type: "text" as const, text: p.text }];
          throw new Error(`a ${p.kind} part in a prompt is not supported yet`);
        });
        if (rest.length > 0) messages.push({ role: "user", content: rest });
      }
    }
    const tools = ToolDefs.parse(JSON.parse(header.toolsJson)).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    return {
      provider: header.provider,
      package: deps.endpoint(header.provider).package,
      modelId: header.model,
      messages,
      tools,
      providerOptions: {},
      maxOutputTokens: input.params.maxTokens,
    };
  }

  async function* stream(
    call: SdkCall,
    opts: { signal: AbortSignal; onRequest: (req: ProviderRequest) => void },
  ): AsyncIterable<StreamEvent> {
    const ctx: StoredContext = {
      provider: call.provider,
      package: call.package,
      packageVersion: VERSIONS[call.package] ?? "unknown",
      modelId: call.modelId,
    };
    const model = makeModel(call, deps.endpoint(call.provider), capturingFetch(opts.onRequest));
    const result = streamText({
      model,
      messages: call.messages as ModelMessage[],
      tools: toolSet(call.tools),
      maxRetries: 0,
      allowSystemInMessages: true,
      abortSignal: opts.signal,
      // Errors arrive as `error` stream parts and become events; the SDK's default handler would print them to the terminal.
      onError: () => {},
      ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
      ...(call.headers === undefined ? {} : { headers: call.headers }),
    });
    const open = new Map<string, { index: number; text: string }>();
    const finished: Array<{ index: number; part: Part }> = [];
    let next = 0;
    const start = (key: string): number => {
      const index = next++;
      open.set(key, { index, text: "" });
      return index;
    };
    const aborted = (): StreamEvent => {
      const parts = finished.sort((a, b) => a.index - b.index).map((f) => f.part);
      return { type: "aborted", completed: parts.length === 0 ? null : { ...toStored({ messages: [] }, ctx), parts } };
    };

    try {
      for await (const p of result.fullStream) {
        if (p.type === "text-start" || p.type === "reasoning-start") start(`${p.type.split("-")[0]}:${p.id}`);
        else if (p.type === "text-delta" || p.type === "reasoning-delta") {
          const kind = p.type === "text-delta" ? "text" : "reasoning";
          const block = open.get(`${kind}:${p.id}`);
          if (block === undefined) continue;
          block.text += p.text;
          yield { type: kind === "text" ? "text.delta" : "reasoning.delta", blockIndex: block.index, text: p.text };
        } else if (p.type === "text-end" || p.type === "reasoning-end") {
          const kind = p.type === "text-end" ? "text" : "reasoning";
          const block = open.get(`${kind}:${p.id}`);
          if (block === undefined) continue;
          open.delete(`${kind}:${p.id}`);
          finished.push({
            index: block.index,
            part:
              kind === "text"
                ? { kind: "text", text: block.text }
                : { kind: "reasoning", summary: block.text, replay: replayOf(ctx, undefined) },
          });
          yield { type: "block.done", blockIndex: block.index, kind };
        } else if (p.type === "tool-input-start") {
          yield { type: "tool_call.start", blockIndex: start(`tool:${p.id}`), id: p.id, name: p.toolName };
        } else if (p.type === "tool-input-delta") {
          const block = open.get(`tool:${p.id}`);
          if (block !== undefined) yield { type: "tool_call.delta", blockIndex: block.index, partialJson: p.delta };
        } else if (p.type === "tool-call") {
          let block = open.get(`tool:${p.toolCallId}`);
          if (block === undefined) {
            const index = start(`tool:${p.toolCallId}`);
            block = { index, text: "" };
            yield { type: "tool_call.start", blockIndex: index, id: p.toolCallId, name: p.toolName };
          }
          open.delete(`tool:${p.toolCallId}`);
          const inputJson = JSON.stringify(p.input);
          finished.push({
            index: block.index,
            part: { kind: "tool_call", id: p.toolCallId, name: p.toolName, inputJson },
          });
          yield { type: "block.done", blockIndex: block.index, kind: "tool_call" };
        } else if (p.type === "finish-step") {
          const raw = (p.usage as { raw?: unknown }).raw;
          yield { type: "usage", usage: z.record(z.string(), z.unknown()).parse(raw ?? p.usage) };
        } else if (p.type === "error") {
          if (opts.signal.aborted) break;
          yield { type: "error", error: classifyError(p.error) };
          return;
        } else if (p.type === "abort") {
          yield aborted();
          return;
        }
      }
    } catch (err) {
      if (!opts.signal.aborted) {
        yield { type: "error", error: classifyError(err) };
        return;
      }
    }
    if (opts.signal.aborted) {
      yield aborted();
      return;
    }
    const response = await result.response;
    const usage = await result.usage;
    const finishReason = await result.finishReason;
    const raw = await result.rawFinishReason;
    const stored = toStored(
      {
        messages: response.messages,
        usage: z.record(z.string(), z.unknown()).parse(usage.raw ?? usage),
        finishReason: raw ?? finishReason,
      },
      ctx,
    );
    const requestId = response.headers?.["x-request-id"];
    yield {
      type: "done",
      stopReason: stopReason(finishReason),
      stored,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  return { render, stream, toStored, fromStored, classifyError };
}
