// Skeleton of the settings schema (interfaces §7); the complete key set arrives with the config loader.
import { z } from "zod";
import { PermissionMode, Usd } from "./primitives.ts";

export const Settings = z.object({
  $version: z.number().int().positive().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  permissions: z
    .object({
      defaultMode: z
        .union([PermissionMode.exclude(["auto"]), z.literal("manual").transform(() => "default" as const)])
        .optional(),
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  budget: z
    .object({
      session: Usd.nullable().optional(),
      daily: Usd.nullable().optional(),
      turn: Usd.nullable().optional(),
    })
    .optional(),
});

export type Settings = z.infer<typeof Settings>;
