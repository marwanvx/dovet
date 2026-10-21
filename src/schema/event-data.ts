// `data` of the events whose first writer exists (event-log "Event types (v0.1)", QUESTIONS Q22).
import { z } from "zod";
import { DocumentPart, ImagePart, InstructionReason } from "./parts.ts";
import { JsonValue } from "./primitives.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const EpochStartData = z.object({
  epoch: z.number().int().nonnegative(),
  reason: z.enum(["session-start", "compaction", "model-switch", "thinking-config-change", "repair"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** The exact bytes sent; resume and replay use these, never a re-render. */
  systemText: z.string(),
  toolsJson: z.string(),
  thinking: z.object({
    mode: z.enum(["adaptive", "enabled", "off"]),
    budgetTokens: z.number().int().positive().optional(),
  }),
  promptVersion: z.string().regex(/^[0-9a-f]{64}$/),
});

export const SystemInjectedData = z.object({
  text: z.string(),
  reason: InstructionReason,
  delivery: z.enum(["system-message", "reminder-block"]),
});

export const InstructionsLoadedData = z.object({
  files: z.array(
    z.object({
      /** Canonical path; resume rebuilds the loaded set from it. */
      path: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().nonnegative(),
      lines: z.number().int().nonnegative(),
      trigger: z.enum(["launch", "lazy-subdir", "path-rule", "changed", "import"]),
    }),
  ),
  warnings: z.array(z.string()),
  /** Canonical paths of launch files that were loaded before and no longer are; resume forgets them. */
  dropped: z.array(z.string().min(1)).optional(),
});

export const UserMessageData = z.object({ text: z.string() });

/** `raw` is what the model sent, `input` what validation saw after normalization (tools §0). */
export const ToolCallData = z.object({
  callId: z.string().min(1),
  name: z.string().min(1),
  raw: JsonValue,
  input: JsonValue,
});

/** An image or PDF a tool returned; `bytes` is the size before base64, which the request budget counts (tools §1.6). */
export const ToolMedia = z.discriminatedUnion("kind", [
  ImagePart.extend({ bytes: z.number().int().nonnegative() }),
  DocumentPart.extend({ bytes: z.number().int().nonnegative() }),
]);

export const ToolResultData = z.object({
  callId: z.string().min(1),
  status: z.enum(["ok", "error", "denied", "interrupted", "timeout"]),
  output: z.string(),
  media: z.array(ToolMedia).optional(),
  /** WebSearch: the backend that answered and what the search cost (tools §10). */
  search: z.object({ backend: z.string(), calls: z.number().int(), priceUsd: z.number().optional() }).optional(),
});

export const TurnEndData = z.object({
  reason: z.enum(["end_turn", "interrupted", "cancelled", "error", "budget", "refusal", "max-turns", "crashed"]),
});

/** A path a snapshot left out of its tree (over the size limits, a submodule, a link): the receipt lists it as not restorable. */
const CheckpointSkipped = z.object({
  path: z.string().min(1),
  reason: z.enum(["too-large", "gitlink", "unsupported", "link", "blocked"]),
});

/**
 * Taken before a turn's first change (checkpoints "Git tree snapshots"). The `blobs` mechanism logs one event per file
 * Dovet's own tools change, all with the turn's id; `before` is the blob-store hash of the old bytes (null = new file).
 */
export const CheckpointData = z.discriminatedUnion("mechanism", [
  z.object({
    id: z.string().regex(/^c\d+$/),
    turn: z.number().int().positive(),
    mechanism: z.literal("git-tree"),
    tree: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    skipped: z.array(CheckpointSkipped),
  }),
  z.object({
    id: z.string().regex(/^c\d+$/),
    turn: z.number().int().positive(),
    mechanism: z.literal("blobs"),
    files: z.array(z.object({ path: z.string().min(1), before: Sha256.nullable() })),
  }),
]);

export const PrefixFingerprint = z.object({ tools: Sha256, system: Sha256, messages: z.array(Sha256) });

export const ModelRequestData = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  params: z.object({ effort: z.string().optional(), maxTokens: z.number().int().positive() }),
  messageCount: z.number().int().nonnegative(),
  bodySha256: Sha256,
  fingerprint: PrefixFingerprint,
});

// First writer is live settings reload (cli-config "Live settings reload", event-log "Event types (v0.1)").
export const SettingsChangeData = z.object({
  key: z.string().min(1),
  old: JsonValue.optional(),
  new: JsonValue.optional(),
  source: z.string().min(1),
});

export type CheckpointData = z.infer<typeof CheckpointData>;
export type EpochStartData = z.infer<typeof EpochStartData>;
export type SystemInjectedData = z.infer<typeof SystemInjectedData>;
export type InstructionsLoadedData = z.infer<typeof InstructionsLoadedData>;
export type UserMessageData = z.infer<typeof UserMessageData>;
export type ToolCallData = z.infer<typeof ToolCallData>;
export type ToolMedia = z.infer<typeof ToolMedia>;
export type ToolResultData = z.infer<typeof ToolResultData>;
export type TurnEndData = z.infer<typeof TurnEndData>;
export type PrefixFingerprint = z.infer<typeof PrefixFingerprint>;
export type ModelRequestData = z.infer<typeof ModelRequestData>;
export type SettingsChangeData = z.infer<typeof SettingsChangeData>;
