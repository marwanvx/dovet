// Read for PDFs (tools §1.7): page count and text with unpdf, page ranges cut with pdf-lib; both load on first use.
import { basename } from "node:path";
import type { DocumentPart } from "../schema/index.ts";
import { stripHidden } from "./hidden.ts";
import { INTERRUPTED_TOOL_TEXT, type MediaContext, type ToolOutput } from "./types.ts";

export const MAX_PDF_FILE_BYTES = 30 * 1024 * 1024;
const TOKENS_PER_PAGE = 3000;
const CHARS_PER_TOKEN = 3.5;
const NO_TEXT = "[No text on this page (a scan or a picture).";

const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });
const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;
const reasonOf = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 120) ?? "";
const label = (from: number, to: number, count: number): string =>
  from === to ? `page ${from} of ${count}` : `pages ${from}–${to} of ${count}`;

/** `slice` that never ends on half a surrogate pair. */
const cut = (text: string, end: number): string => {
  const head = text.slice(0, end);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
};

/** The 1-based pages one `pages` value names, or the error text. */
function parsePages(spec: string, count: number, perCall: number): { from: number; to: number } | string {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec);
  if (m === null) return `pages must be one page like "3" or one range like "1-5"; got "${spec}".`;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1) return `pages "${spec}" is not valid: page numbers start at 1.`;
  if (to < from) return `pages "${spec}" is not valid: the range ends before it starts.`;
  if (to > count) return `The PDF has ${count} ${count === 1 ? "page" : "pages"}; pages "${spec}" goes past the end.`;
  if (to - from + 1 > perCall)
    return `Read at most ${perCall} pages per call (the read limit allows ~${TOKENS_PER_PAGE} tokens a page); pages "${spec}" asks for ${to - from + 1}.`;
  return { from, to };
}

export type PdfRequest = {
  path: string;
  bytes: Uint8Array;
  pages: string | undefined;
  maxTokens: number;
  media: MediaContext | undefined;
  signal: AbortSignal;
};

export async function readPdf(req: PdfRequest): Promise<ToolOutput> {
  const { path, bytes, media, signal } = req;
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js takes ownership of the buffer it is given; the original is still needed to send or cut.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (e) {
    if (e instanceof Error && e.name === "PasswordException")
      return fail(`${path} is password-protected; remove the password first (for example with qpdf --decrypt).`);
    return fail(`${path} could not be read as a PDF (${reasonOf(e)}); it was not read.`);
  }
  try {
    const count = pdf.numPages;
    const perCall = Math.max(1, Math.floor(req.maxTokens / TOKENS_PER_PAGE));
    let from = 1;
    let to = count;
    if (req.pages !== undefined) {
      const range = parsePages(req.pages, count, perCall);
      if (typeof range === "string") return fail(range);
      ({ from, to } = range);
    } else if (count > perCall) {
      return fail(
        `${path} has ${count} pages, too many to read at once (at most ${perCall} pages fit the read limit): pass pages, for example "1-${perCall}".`,
      );
    }
    const sent = to - from + 1;
    const whole = sent === count;

    if (media?.pdfs === true && (media.pdfMaxPages === null || sent <= media.pdfMaxPages)) {
      let body = bytes;
      if (!whole) {
        try {
          body = await cutPages(bytes, from, to);
        } catch (e) {
          return fail(`${path}: pages ${from}–${to} could not be cut out (${reasonOf(e)}); they were not sent.`);
        }
      }
      const refused = media.claim(body.length, "document");
      if (refused !== undefined) return fail(refused);
      const part: DocumentPart = {
        kind: "document",
        blob: { store: "blob", id: media.store(body) },
        mediaType: "application/pdf",
        title: basename(path),
      };
      const note = whole
        ? `PDF ${path}: ${count} pages, ${kb(body.length)}, sent whole as a document.`
        : `PDF ${path}: ${label(from, to, count)} sent as a ${sent}-page document, ${kb(body.length)}.`;
      return { status: "ok", content: [{ kind: "text", text: note }, part] };
    }

    return await pagesAsText(pdf, {
      path,
      from,
      to,
      count,
      media,
      signal,
      budgetChars: req.maxTokens * CHARS_PER_TOKEN,
    });
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function cutPages(bytes: Uint8Array, from: number, to: number): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = await PDFDocument.create();
  const indices = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  for (const page of await out.copyPages(source, indices)) out.addPage(page);
  return out.save();
}

async function pagesAsText(
  pdf: { getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): unknown }> },
  at: {
    path: string;
    from: number;
    to: number;
    count: number;
    media: MediaContext | undefined;
    signal: AbortSignal;
    budgetChars: number;
  },
): Promise<ToolOutput> {
  const sections: string[] = [];
  let used = 0;
  let hidden = 0;
  let notice = "";
  for (let n = at.from; n <= at.to; n += 1) {
    if (at.signal.aborted) return { status: "interrupted", content: [{ kind: "text", text: INTERRUPTED_TOOL_TEXT }] };
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    page.cleanup();
    const raw = content.items
      .map((i) => {
        const item = i as { str?: unknown; hasEOL?: unknown };
        return typeof item.str === "string" ? item.str + (item.hasEOL === true ? "\n" : "") : "";
      })
      .join("")
      .trimEnd();
    const clean = stripHidden(raw);
    hidden += clean.removed;
    let body = clean.text;
    if (body.trim() === "") body = `${NO_TEXT}${at.media?.pdfs === true ? "" : " This model can't view PDF pages."}]`;
    const section = `--- Page ${n} ---\n${body}`;
    if (used + section.length > at.budgetChars) {
      if (sections.length === 0) {
        sections.push(cut(section, at.budgetChars));
        notice = `[PARTIAL view: page ${n} is longer than the read limit (~${Math.ceil(section.length / CHARS_PER_TOKEN)} tokens); the rest of it is cut.]`;
      } else {
        notice = `[PARTIAL view: pages ${at.from}–${n - 1} of the ${at.from}–${at.to} you asked for fit the read limit. Continue with pages="${n}-${at.to}".]`;
      }
      break;
    }
    sections.push(section);
    used += section.length + 1;
  }
  const parts = [`PDF ${at.path}: text of ${label(at.from, at.to, at.count)}.`, ...sections];
  if (notice !== "") parts.push(notice);
  if (hidden > 0)
    parts.push(`[${hidden} hidden characters were removed from this view; the file on disk still contains them.]`);
  return {
    status: "ok",
    content: [{ kind: "text", text: parts.join("\n") }],
    ...(hidden > 0 ? { meta: { effects: [{ kind: "taint" as const, source: `Read: ${at.path}` }] } } : {}),
  };
}
