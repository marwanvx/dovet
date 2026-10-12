// Conversation parts, the format the event log stores (interfaces §2).
import { z } from "zod";
import { BlobRef, JsonValue, Protocol } from "./primitives.ts";

export const InstructionReason = z.enum([
  "interrupt-note",
  "continue-after-drop",
  "mode-change",
  "sandbox-changed",
  "plan-approved",
  "plan-not-approved",
  "plan-left",
  "plan-reattach",
  "restore-note",
  "instructions-updated",
  "lazy-instructions",
  "user-shell-output",
  "silence-reminder",
  "open-tasks",
  "budget-warning",
  "queued-messages",
]);

export const ReplayData = z.object({
  provider: z.string().min(1),
  protocol: Protocol,
  modelId: z.string().min(1),
  fields: z.record(z.string(), JsonValue),
});

export const TextPart = z.object({
  kind: z.literal("text"),
  text: z.string(),
  phase: z.enum(["commentary", "final_answer"]).optional(),
  replay: ReplayData.optional(),
});

export const ImagePart = z.object({
  kind: z.literal("image"),
  blob: BlobRef,
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
});

export const DocumentPart = z.object({
  kind: z.literal("document"),
  blob: BlobRef,
  mediaType: z.literal("application/pdf"),
  title: z.string().optional(),
});

export const Part = z.discriminatedUnion("kind", [
  TextPart,
  ImagePart,
  DocumentPart,
  z.object({ kind: z.literal("reasoning"), summary: z.string().nullable(), replay: ReplayData.optional() }),
  z.object({
    kind: z.literal("tool_call"),
    id: z.string().min(1),
    name: z.string().min(1),
    inputJson: z.string(),
    replay: ReplayData.optional(),
  }),
  z.object({
    kind: z.literal("tool_result"),
    callId: z.string().min(1),
    isError: z.boolean(),
    content: z.array(z.discriminatedUnion("kind", [TextPart, ImagePart, DocumentPart])),
  }),
  z.object({ kind: z.literal("instruction"), text: z.string(), reason: InstructionReason }),
]);

export const StoredResponse = z.object({
  provider: z.string().min(1),
  protocol: Protocol,
  package: z.string().min(1),
  packageVersion: z.string().min(1),
  modelId: z.string().min(1),
  parts: z.array(Part),
  usage: z.record(z.string(), z.unknown()),
  finishReason: z.string(),
  rawBody: BlobRef.optional(),
});

export type InstructionReason = z.infer<typeof InstructionReason>;
export type ReplayData = z.infer<typeof ReplayData>;
export type TextPart = z.infer<typeof TextPart>;
export type ImagePart = z.infer<typeof ImagePart>;
export type DocumentPart = z.infer<typeof DocumentPart>;
export type Part = z.infer<typeof Part>;
export type StoredResponse = z.infer<typeof StoredResponse>;
