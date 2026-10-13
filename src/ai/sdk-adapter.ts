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
    const raw = init?.body;
    let body: string;
    if (raw === undefined || raw === null) body = "";
    else if (typeof raw === "string") body = raw;
    else if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) body = new TextDecoder().decode(raw);
    else throw new Error("a provider request body that is not text or bytes can't be recorded exactly");
    const headers: Record<string, string> = {};
    const all = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => {
      all.set(key, value);
    });
    all.forEach((value, key) => {
      headers[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value;
    });
    const url = input instanceof Request ? input.url : String(input);
    onRequest({ url, headers, body, bodySha256: new Bun.CryptoHasher("sha256").update(body).digest("hex") });
    return base(input, init);
  };
  return Object.assign(capture, { preconnect: base.preconnect });
}

/** Tool order is part of the prefix (context §7): plain code-unit order, the same for every caller. */
export function sortTools<T extends { name: string }>(defs: readonly T[]): T[] {
  return [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ConnectionRefused",
  "ConnectionClosed",
]);

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  return err instanceof TypeError && /fetch failed|network|socket|connection/i.test(err.message);
}

/** `secrets` (the endpoint's credential) never appear in the message (interfaces §3). */
export function classifyError(err: unknown, secrets: readonly string[] = []): ProviderErrorInfo {
  const info = classify(err);
  const message = secrets.reduce((m, s) => (s === "" ? m : m.replaceAll(s, "[redacted]")), info.message);
  return { ...info, message };
}

function classify(err: unknown): ProviderErrorInfo {
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
  if (isNetworkError(err)) return { kind: "network", retryable: true, message: (err as Error).message };
  return { kind: "unknown", retryable: false, message: err instanceof Error ? err.message : String(err) };
}

type StoredContext = { provider: string; package: string; packageVersion: string; modelId: string };

const ProviderOptions = z.record(z.string(), z.record(z.string(), z.json()));

function providerOptionsOf(fields: Record<string, unknown>) {
  return ProviderOptions.parse(fields);
}

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

/** An invalid call keeps the model's raw argument text, so the loop can show the model what it sent. */
function inputJsonOf(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function inputOf(inputJson: string): unknown {
  try {
    return JSON.parse(inputJson);
  } catch {
    return inputJson;
  }
}

/** Lossless: the step's SDK response messages → Dovet parts with replay data (providers §1). */
export function toStored(
  result: { messages: readonly ModelMessage[]; usage?: Record<string, unknown>; finishReason?: string },
  ctx: StoredContext,
): StoredResponse {
  const parts: Part[] = [];
  for (const message of result.messages) {
    // The SDK answers an invalid or unknown tool call itself with a tool-error message; Dovet's loop reports it instead.
    if (message.role === "tool") continue;
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
          inputJson: inputJsonOf(p.input),
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
        ? { providerOptions: providerOptionsOf(p.replay.fields) }
        : {};
    if (p.kind === "text") content.push({ type: "text", text: p.text, ...opts });
    else if (p.kind === "reasoning") {
      if (!same) continue;
      const fields = p.replay?.fields ?? {};
      content.push({
        type: "reasoning",
        text: p.summary ?? "",
        ...(Object.keys(fields).length > 0 ? { providerOptions: providerOptionsOf(fields) } : {}),
      });
    } else if (p.kind === "tool_call") {
      content.push({
        type: "tool-call",
        toolCallId: id(p.id),
        toolName: p.name,
        input: inputOf(p.inputJson),
        ...opts,
      });
    } else throw new Error(`an assistant turn can't hold a ${p.kind} part`);
  }
  return content.length === 0 ? [] : [{ role: "assistant", content }];
}

function replayIf(ctx: StoredContext, metadata: Record<string, unknown> | undefined): { replay?: ReplayData } {
  return metadata === undefined ? {} : { replay: replayOf(ctx, metadata) };
}

/** The provider's own usage object when the package exposes it; otherwise the SDK's normalized one. */
function rawUsage(usage: { raw?: Record<string, unknown> | undefined }): Record<string, unknown> {
  return usage.raw ?? z.record(z.string(), z.unknown()).parse(usage);
}

function versionOf(name: string): string {
  const version = VERSIONS[name];
  if (version === undefined) throw new Error(`${name} is not a pinned dependency`);
  return version;
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
              const value = r.content
                .map((c) => {
                  if (c.kind !== "text") throw new Error(`a ${c.kind} in a tool result is not supported yet`);
                  return c.text;
                })
                .join("");
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
    const tools = sortTools(ToolDefs.parse(JSON.parse(header.toolsJson)));
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
      packageVersion: versionOf(call.package),
      modelId: call.modelId,
    };
    const endpoint = deps.endpoint(call.provider);
    const secrets = endpoint.apiKey === undefined ? [] : [endpoint.apiKey.reveal()];
    const model = makeModel(call, endpoint, capturingFetch(opts.onRequest));
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
    // The SDK replaces a malformed call's input with {} in its response messages; the raw text exists only here.
    const rawInputs = new Map<string, string>();
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
                ? { kind: "text", text: block.text, ...replayIf(ctx, p.providerMetadata) }
                : { kind: "reasoning", summary: block.text, replay: replayOf(ctx, p.providerMetadata) },
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
          const inputJson = inputJsonOf(p.input);
          if (p.invalid === true && typeof p.input === "string") rawInputs.set(p.toolCallId, p.input);
          finished.push({
            index: block.index,
            part: {
              kind: "tool_call",
              id: p.toolCallId,
              name: p.toolName,
              inputJson,
              ...replayIf(ctx, p.providerMetadata),
            },
          });
          yield { type: "block.done", blockIndex: block.index, kind: "tool_call" };
        } else if (p.type === "finish-step") {
          yield { type: "usage", usage: rawUsage(p.usage) };
        } else if (p.type === "error") {
          if (opts.signal.aborted) break;
          yield { type: "error", error: classifyError(p.error, secrets) };
          return;
        } else if (p.type === "abort") {
          yield aborted();
          return;
        }
      }
    } catch (err) {
      if (!opts.signal.aborted) {
        yield { type: "error", error: classifyError(err, secrets) };
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
    let stored: StoredResponse;
    try {
      stored = toStored(
        { messages: response.messages, usage: rawUsage(usage), finishReason: raw ?? finishReason },
        ctx,
      );
      stored.parts = stored.parts.map((part) => {
        const rawInput = part.kind === "tool_call" ? rawInputs.get(part.id) : undefined;
        return rawInput === undefined ? part : { ...part, inputJson: rawInput };
      });
    } catch (err) {
      yield {
        type: "error",
        error: {
          kind: "unknown",
          retryable: false,
          message: `the response could not be stored: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
      return;
    }
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
