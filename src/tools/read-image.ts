// Read for images (tools §1.6): decode check, resize to the long-edge limit, re-encode, budgets.
import type { ImagePart } from "../schema/index.ts";
import type { MediaContext, ToolOutput } from "./types.ts";

export const MAX_IMAGE_FILE_BYTES = 30 * 1024 * 1024;
const MAX_LONG_EDGE = 2000;
const MAX_PIXELS = 64_000_000;
const TARGET_BYTES = 500 * 1024;
const HARD_CAP_BYTES = 5 * 1024 * 1024;
const QUALITIES = [85, 80, 75, 70];

const MEDIA_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
type Sendable = keyof typeof MEDIA_TYPES;

const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });
const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;

/** Frames in a GIF, by walking its blocks; a damaged stream counts what it reached. */
export function gifFrames(b: Uint8Array): number {
  if (b.length < 13) return 0;
  let i = 13 + ((b[10] ?? 0) & 0x80 ? 3 * 2 ** (((b[10] ?? 0) & 7) + 1) : 0);
  let frames = 0;
  const skipSubBlocks = (): void => {
    while (i < b.length && b[i] !== 0) i += (b[i] ?? 0) + 1;
    i += 1;
  };
  while (i < b.length && b[i] !== 0x3b) {
    if (b[i] === 0x21) {
      i += 2;
      skipSubBlocks();
    } else if (b[i] === 0x2c) {
      frames += 1;
      const flags = b[i + 9] ?? 0;
      i += 10 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0) + 1;
      skipSubBlocks();
    } else {
      break;
    }
  }
  return frames;
}

async function encode(bytes: Uint8Array, edge: number, format: "png" | "jpeg" | "webp", quality: number) {
  const image = new Bun.Image(bytes, { maxPixels: MAX_PIXELS }).resize(edge, edge, {
    fit: "inside",
    withoutEnlargement: true,
  });
  if (format === "png") return image.png().bytes();
  return format === "jpeg" ? image.jpeg({ quality }).bytes() : image.webp({ quality }).bytes();
}

export async function readImage(path: string, bytes: Uint8Array, media: MediaContext): Promise<ToolOutput> {
  let meta: Bun.Image.Metadata;
  try {
    meta = await new Bun.Image(bytes, { maxPixels: MAX_PIXELS }).metadata();
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String(e.code) : "";
    return fail(
      code === "ERR_IMAGE_TOO_MANY_PIXELS"
        ? `${path} has more than ${MAX_PIXELS / 1e6} million pixels; it was not sent.`
        : `${path} could not be decoded as an image (${code || "unreadable"}); it was not sent.`,
    );
  }
  if (!(meta.format in MEDIA_TYPES))
    return fail(`${path} is a ${meta.format} image, which models cannot take; it was not sent.`);
  const source = meta.format as Sendable;
  const edge = Math.min(MAX_LONG_EDGE, media.longEdge);
  const resize = Math.max(meta.width, meta.height) > edge;

  let out: { bytes: Uint8Array; type: Sendable };
  try {
    if (!resize && source !== "gif" && bytes.length <= TARGET_BYTES) {
      // Decoding the whole picture is the check that it is not damaged; the original bytes are what is sent.
      await encode(bytes, 64, "png", 0);
      out = { bytes, type: source };
    } else {
      const first =
        resize || source === "gif" ? await encode(bytes, edge, source === "gif" ? "png" : source, 85) : bytes;
      out = { bytes: first, type: source === "gif" ? "png" : source };
      for (let q = 0; out.bytes.length > TARGET_BYTES && q < QUALITIES.length; q += 1) {
        out = { bytes: await encode(bytes, edge, "jpeg", QUALITIES[q] ?? 70), type: "jpeg" };
      }
    }
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String(e.code) : "";
    return fail(`${path} could not be decoded as an image (${code || "unreadable"}); it was not sent.`);
  }
  if (out.bytes.length > HARD_CAP_BYTES)
    return fail(
      `${path} is still ${kb(out.bytes.length)} after resizing; images over ${kb(HARD_CAP_BYTES)} are not sent.`,
    );

  const refused = media.claim(out.bytes.length, "image");
  if (refused !== undefined) return fail(refused);

  const shown = out.bytes === bytes ? meta : await new Bun.Image(out.bytes).metadata();
  const animated = source === "gif" && gifFrames(bytes) > 1;
  const notes = [
    `Image ${path}: ${meta.width}×${meta.height} ${source}, ${kb(bytes.length)}.`,
    shown.width === meta.width && shown.height === meta.height && out.bytes === bytes
      ? "Sent as it is."
      : `Sent as ${shown.width}×${shown.height} ${out.type}, ${kb(out.bytes.length)}.`,
    ...(animated ? ["Animated GIF: only the first frame is shown."] : []),
  ];
  const part: ImagePart = {
    kind: "image",
    blob: { store: "blob", id: media.store(out.bytes) },
    mediaType: MEDIA_TYPES[out.type],
  };
  return { status: "ok", content: [{ kind: "text", text: notes.join(" ") }, part] };
}
