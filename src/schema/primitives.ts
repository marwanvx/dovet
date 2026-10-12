// Shared primitives (interfaces §1).
import { z } from "zod";

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const IsoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
export const AbsPath = z.string().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/);

export const BlobRef = z.discriminatedUnion("store", [
  z.object({ store: z.literal("blob"), id: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ store: z.literal("git"), id: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }),
]);

export const Protocol = z.enum(["anthropic-messages", "openai-responses", "google-interactions", "openai-chat"]);
export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "auto"]);
export const Usd = z.number().finite().nonnegative();
export const JsonValue = z.json();

export type Ulid = z.infer<typeof Ulid>;
export type IsoTime = z.infer<typeof IsoTime>;
export type AbsPath = z.infer<typeof AbsPath>;
export type BlobRef = z.infer<typeof BlobRef>;
export type Protocol = z.infer<typeof Protocol>;
export type PermissionMode = z.infer<typeof PermissionMode>;
export type Usd = z.infer<typeof Usd>;
export type JsonValue = z.infer<typeof JsonValue>;
