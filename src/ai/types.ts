// The adapter contract (interfaces §2b and §3).
import type { Part, StoredResponse } from "../schema/index.ts";

export type EpochHeader = {
  epoch: number;
  provider: string;
  model: string;
  promptVersion: string;
  systemText: string;
  /** Exact serialized bytes: a JSON array of `{ name, description, inputSchema }`. */
  toolsJson: string;
  thinking: { mode: "adaptive" | "enabled" | "off"; budgetTokens?: number };
};

export type TranscriptItem =
  | { kind: "user"; parts: Part[] }
  | { kind: "assistant"; stored: StoredResponse }
  | { kind: "system"; text: string };

export type RenderInput = {
  header: EpochHeader;
  params: { effort?: string; maxTokens: number };
  transcript: TranscriptItem[];
  cache: { breakpoints: "auto" | "explicit"; ttl: "auto" | "5m" | "1h" };
};

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

export type SdkCall = {
  provider: string;
  package: string;
  modelId: string;
  messages: unknown;
  tools: ToolDef[];
  providerOptions: Record<string, unknown>;
  maxOutputTokens?: number;
  headers?: Record<string, string>;
};

export type ProviderRequest = { url: string; headers: Record<string, string>; body: string; bodySha256: string };

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "context_exceeded"
  | "refusal"
  | "pause"
  | "stop_sequence"
  | { other: string };

export interface ProviderErrorInfo {
  kind:
    | "rate_limit"
    | "overloaded"
    | "server"
    | "network"
    | "timeout"
    | "auth"
    | "billing"
    | "quota"
    | "invalid_request"
    | "not_found"
    | "too_large"
    | "refusal_policy"
    | "prefix_mismatch"
    | "unknown";
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
  requestId?: string;
  message: string;
}

export type StreamEvent =
  | { type: "text.delta"; blockIndex: number; text: string }
  | { type: "reasoning.delta"; blockIndex: number; text: string }
  | { type: "tool_call.start"; blockIndex: number; id: string; name: string }
  | { type: "tool_call.delta"; blockIndex: number; partialJson: string }
  | { type: "block.done"; blockIndex: number; kind: "text" | "reasoning" | "tool_call" }
  | { type: "usage"; usage: Record<string, unknown> }
  | { type: "done"; stopReason: StopReason; stored: StoredResponse; requestId?: string }
  | { type: "error"; error: ProviderErrorInfo }
  | { type: "aborted"; completed: StoredResponse | null };
