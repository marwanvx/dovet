// `data` of the events whose first writer exists (event-log "Event types (v0.1)", QUESTIONS Q22).
import { z } from "zod";
import { InstructionReason } from "./parts.ts";

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
});

export type EpochStartData = z.infer<typeof EpochStartData>;
export type SystemInjectedData = z.infer<typeof SystemInjectedData>;
export type InstructionsLoadedData = z.infer<typeof InstructionsLoadedData>;
