// Output limiting for non-shell tools (tools §0): a 2,000-character preview inline, everything else in a pageable offload file.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OUTPUT_LIMIT = 30_000;
const PREVIEW = 2_000;
const MAX_LINE = 2_000;

export type OffloadTarget = { dir: string; id: string };

function wrapLine(line: string): string[] {
  if (line.length <= MAX_LINE) return [line];
  const pieces: string[] = [];
  for (let i = 0; i < line.length; ) {
    let end = Math.min(i + MAX_LINE, line.length);
    const last = line.charCodeAt(end - 1);
    if (end < line.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(line.slice(i, end));
    i = end;
  }
  return pieces;
}

function pageable(text: string): { body: string; ext: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const isJson = typeof json === "object" && json !== null;
  const source = isJson ? JSON.stringify(json, null, 2) : text;
  return { body: source.split("\n").flatMap(wrapLine).join("\n"), ext: isJson ? "json" : "txt" };
}

export async function limitOutput(
  text: string,
  target: OffloadTarget,
): Promise<{ text: string; offloadPath?: string }> {
  if (text.length <= OUTPUT_LIMIT) return { text };
  const { body, ext } = pageable(text);
  await mkdir(target.dir, { recursive: true, mode: 0o700 });
  const path = join(target.dir, `${target.id}.${ext}`);
  await writeFile(path, body, { mode: 0o600 });
  const note = `[Output too long (${text.length} chars). Full output saved to ${path}. Read it with offset/limit or search it.]`;
  return { text: `${text.slice(0, PREVIEW)}\n${note}`, offloadPath: path };
}
