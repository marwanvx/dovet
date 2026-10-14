// Streaming text scan for Read (tools §1.2b, §1.4): bounded, decodes BOMs, keeps only the lines the view needs, counts the rest.
import type { FileHandle } from "node:fs/promises";
import { stripHidden } from "./hidden.ts";

export const MAX_SCAN_BYTES = 50 * 1024 * 1024;
const CHUNK = 64 * 1024;
const MAX_LINE = 2_000;

export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "invalid";
export type ShownLine = { n: number; text: string; hidden: number };

export type ScanOptions = {
  start: number;
  maxLines: number;
  /** Characters of formatted output to keep; the first line is always kept. */
  budgetChars: number;
};

export type Scan =
  | { binary: true; detected: string }
  | {
      binary: false;
      encoding: Encoding;
      eol: "lf" | "crlf";
      sha256: string;
      total: number;
      totalChars: number;
      capped: boolean;
      shown: ShownLine[];
      shownChars: number;
      /** Retention stopped because of the character budget, not the line limit. */
      budgetHit: boolean;
    };

const MAGIC: Array<[string, number[]]> = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]],
  ["application/zip", [0x50, 0x4b, 0x03, 0x04]],
  ["application/gzip", [0x1f, 0x8b]],
  ["application/x-executable", [0x7f, 0x45, 0x4c, 0x46]],
];

function detectType(head: Uint8Array): string {
  if (
    head.length >= 12 &&
    String.fromCharCode(...head.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...head.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  for (const [type, magic] of MAGIC) if (magic.every((b, i) => head[i] === b)) return type;
  return "application/octet-stream";
}

function clip(text: string): string {
  return text.length <= MAX_LINE ? text : `${text.slice(0, MAX_LINE)}… [line truncated, ${text.length} chars]`;
}

const shownLength = (n: number, length: number): number =>
  String(n).length + 2 + (length <= MAX_LINE ? length : MAX_LINE + `… [line truncated, ${length} chars]`.length);

export const formatLine = (l: ShownLine): string => `${l.n}\t${l.text}`;

export async function scanText(fh: FileHandle, opts: ScanOptions): Promise<Scan> {
  const hasher = new Bun.CryptoHasher("sha256");
  const chunk = new Uint8Array(CHUNK);
  let bytes = 0;
  let encoding: Encoding = "utf-8";
  let lenient = new TextDecoder("utf-8");
  let strict: TextDecoder | undefined = new TextDecoder("utf-8", { fatal: true });
  let invalid = false;
  let eol: "lf" | "crlf" | undefined;
  let carry = "";
  let n = 0;
  let totalChars = 0;
  let capped = false;
  let budgetHit = false;
  let shownChars = 0;
  const shown: ShownLine[] = [];

  const onLine = (raw: string): void => {
    n += 1;
    totalChars += shownLength(n, raw.length);
    if (n < opts.start || budgetHit || shown.length >= opts.maxLines) return;
    const { text, removed } = stripHidden(raw);
    const line: ShownLine = { n, text: clip(text), hidden: removed };
    const size = shownLength(n, line.text.length);
    if (shown.length > 0 && shownChars + size > opts.budgetChars) {
      budgetHit = true;
      return;
    }
    shown.push(line);
    shownChars += size;
  };

  const feed = (piece: string): void => {
    const parts = (carry + piece).split("\n");
    carry = parts.pop() ?? "";
    for (const part of parts) {
      const crlf = part.endsWith("\r");
      eol ??= crlf ? "crlf" : "lf";
      onLine(crlf ? part.slice(0, -1) : part);
    }
  };

  for (let first = true; ; first = false) {
    const { bytesRead } = await fh.read(chunk, 0, CHUNK, null);
    if (bytesRead === 0) break;
    let view = chunk.subarray(0, bytesRead);
    if (first) {
      const [a, b, c] = view;
      if (a === 0xef && b === 0xbb && c === 0xbf) {
        encoding = "utf-8-bom";
        view = view.subarray(3);
      } else if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) {
        encoding = a === 0xff ? "utf-16le" : "utf-16be";
        lenient = new TextDecoder(encoding);
        strict = undefined;
        view = view.subarray(2);
      } else if (view.subarray(0, 8192).includes(0)) {
        return { binary: true, detected: detectType(view) };
      }
    }
    hasher.update(chunk.subarray(0, bytesRead));
    bytes += bytesRead;
    if (strict && !invalid) {
      try {
        strict.decode(view, { stream: true });
      } catch {
        invalid = true;
      }
    }
    feed(lenient.decode(view, { stream: true }));
    if (bytes >= MAX_SCAN_BYTES) {
      capped = true;
      break;
    }
  }
  feed(lenient.decode());
  if (strict && !invalid) {
    try {
      strict.decode();
    } catch {
      invalid = true;
    }
  }
  if (carry !== "") onLine(carry);
  return {
    binary: false,
    encoding: invalid ? "invalid" : encoding,
    eol: eol ?? "lf",
    sha256: hasher.digest("hex"),
    total: n,
    totalChars,
    capped,
    shown,
    shownChars,
    budgetHit,
  };
}
