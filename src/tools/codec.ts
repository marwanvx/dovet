// Text encodings and line endings shared by Write and Edit.
import { createHash } from "node:crypto";
import type { Encoding } from "./read-scan.ts";

export function decode(bytes: Uint8Array, encoding: Encoding): string {
  switch (encoding) {
    case "utf8-bom":
      return new TextDecoder().decode(bytes.subarray(3));
    case "utf16le":
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    case "utf16be":
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    default:
      return new TextDecoder().decode(bytes);
  }
}

export function encode(text: string, encoding: Encoding): Uint8Array {
  switch (encoding) {
    case "utf8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf16be":
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
    default:
      return Buffer.from(text);
  }
}

/** The encoding a file's bytes are in, from a BOM or a strict UTF-8 decode. */
export function sniffEncoding(bytes: Uint8Array): Encoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf8-bom";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf8";
  } catch {
    return "invalid";
  }
}

export function dominantEol(text: string, fallback: "\n" | "\r\n" | "mixed"): "\n" | "\r\n" {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  if (crlf !== lf) return crlf > lf ? "\r\n" : "\n";
  return fallback === "\r\n" ? "\r\n" : "\n";
}

export const sha256Of = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
