// Mid-epoch instructions (context §4) and instruction-file change detection (context §3 "Changes during a session").
import { readFile, stat } from "node:fs/promises";
import { isErrno } from "../../platform/index.ts";
import type { AbsPath, Part, Protocol } from "../../schema/index.ts";
import { escapeReservedMarkers } from "./markers.ts";

export type InstructionPart = Extract<Part, { kind: "instruction" }>;

/**
 * `system`: its own system (or developer) message after the latest user or tool-result message. `part`: a part of the
 * next user message, which the adapter marks `[Dovet instruction]` where the protocol needs it.
 */
export type Delivery = { kind: "system"; text: string } | { kind: "part"; part: InstructionPart };

export function deliverInstruction(
  protocol: Protocol,
  part: InstructionPart,
  caps: { systemMessages?: boolean } = {},
): Delivery {
  const asSystem =
    protocol === "openai-responses" || (protocol === "anthropic-messages" && caps.systemMessages === true);
  return asSystem ? { kind: "system", text: part.text } : { kind: "part", part };
}

export type LoadedInstruction = {
  path: AbsPath;
  displayPath: string;
  content: string;
  mtimeMs: number;
  sha256: string;
};

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

export async function loadInstruction(path: AbsPath, displayPath: string): Promise<LoadedInstruction> {
  const [info, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
  return { path, displayPath, content, mtimeMs: info.mtimeMs, sha256: sha256(content) };
}

export function instructionsUpdated(displayPath: string, content: string): InstructionPart {
  return {
    kind: "instruction",
    reason: "instructions-updated",
    text: `Instructions updated (${escapeReservedMarkers(displayPath)}):\n${escapeReservedMarkers(content)}`,
  };
}

/** Before each user turn: re-stat every loaded file, hash only those whose mtime moved. */
export async function changedInstructions(
  loaded: readonly LoadedInstruction[],
): Promise<{ loaded: LoadedInstruction[]; instructions: InstructionPart[] }> {
  const next: LoadedInstruction[] = [];
  const instructions: InstructionPart[] = [];
  for (const file of loaded) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file.path)).mtimeMs;
    } catch (e) {
      if (!isErrno(e, "ENOENT", "ENOTDIR")) throw e;
      // ASSUMPTION (QUESTIONS Q29): a deleted file is announced once and stops being watched.
      instructions.push(instructionsUpdated(file.displayPath, "(the file was deleted)"));
      continue;
    }
    if (mtimeMs === file.mtimeMs) {
      next.push(file);
      continue;
    }
    const fresh = await loadInstruction(file.path, file.displayPath);
    if (fresh.sha256 !== file.sha256) instructions.push(instructionsUpdated(file.displayPath, fresh.content));
    next.push(fresh);
  }
  return { loaded: next, instructions };
}
