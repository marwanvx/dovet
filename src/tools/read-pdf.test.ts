import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocumentProxy } from "unpdf";
import { ENCRYPTED_PDF, numberedPdf, testPdf } from "../../test/helpers/index.ts";
import { Settings } from "../schema/index.ts";
import { createReadTool, createToolRegistry, type MediaContext, type ToolContext, type ToolOutput } from "./index.ts";
import { context, text, workspace } from "./test-context.ts";

async function read(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const tool = createReadTool();
  const prepared = createToolRegistry([tool]).prepare("Read", input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, ctx);
}

function media(over: Partial<MediaContext> & { stored?: Uint8Array[]; claimed?: number[] } = {}): MediaContext {
  const stored = over.stored ?? [];
  const claimed = over.claimed ?? [];
  return {
    images: false,
    longEdge: 2000,
    pdfs: true,
    pdfMaxPages: null,
    claim: (bytes) => {
      claimed.push(bytes);
      return undefined;
    },
    store: (bytes) => {
      stored.push(bytes);
      return `${stored.length}`.padStart(64, "0");
    },
    ...over,
  };
}

const documentOf = (out: ToolOutput) => out.content.find((p) => p.kind === "document");

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map((i) => ("str" in i ? i.str : "")).join(""));
  }
  return pages;
}

async function withPdf(bytes: Uint8Array, name = "doc.pdf"): Promise<string> {
  const cwd = await workspace();
  await writeFile(join(cwd, name), bytes);
  return cwd;
}

describe("Read: PDFs sent as documents", () => {
  // spec: AC-TOOLS-02
  test("a PDF of 8 pages is sent whole as a document block", async () => {
    const bytes = numberedPdf(8);
    const cwd = await withPdf(bytes);
    const stored: Uint8Array[] = [];
    const claimed: number[] = [];
    const out = await read(context(cwd, { media: media({ stored, claimed }) }), { file_path: "doc.pdf" });
    expect(out.status).toBe("ok");
    const doc = documentOf(out);
    expect(doc?.mediaType).toBe("application/pdf");
    expect(Buffer.from(stored[0] ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(claimed).toEqual([bytes.length]);
    expect(text(out)).toContain("8 pages");
  });

  // spec: AC-TOOLS-02
  test("a 30-page PDF without pages is refused with an error that names pages", async () => {
    const cwd = await withPdf(numberedPdf(30));
    const out = await read(context(cwd, { media: media() }), { file_path: "doc.pdf" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("30 pages");
    expect(text(out)).toContain("pages");
    expect(text(out)).toContain('"1-8"');
    expect(documentOf(out)).toBeUndefined();
  });

  // spec: AC-TOOLS-02
  test("pages cuts a new PDF holding only those pages", async () => {
    const cwd = await withPdf(numberedPdf(30));
    const stored: Uint8Array[] = [];
    const out = await read(context(cwd, { media: media({ stored }) }), { file_path: "doc.pdf", pages: "4-6" });
    expect(out.status).toBe("ok");
    expect(documentOf(out)).toBeDefined();
    const cut = await pageTexts(stored[0] ?? new Uint8Array());
    expect(cut).toHaveLength(3);
    expect(cut[0]).toContain("Page 4 of 30");
    expect(cut[2]).toContain("Page 6 of 30");
    expect(text(out)).toContain("pages 4–6 of 30");
  });

  // spec: AC-TOOLS-02
  test("a single page is cut the same way", async () => {
    const cwd = await withPdf(numberedPdf(30));
    const stored: Uint8Array[] = [];
    await read(context(cwd, { media: media({ stored }) }), { file_path: "doc.pdf", pages: "30" });
    expect(await pageTexts(stored[0] ?? new Uint8Array())).toEqual([expect.stringContaining("Page 30 of 30")]);
  });

  // spec: AC-TOOLS-02
  test("the byte budget refuses a document that does not fit", async () => {
    const cwd = await withPdf(numberedPdf(2));
    const out = await read(
      context(cwd, { media: media({ claim: () => "Images and documents already take 19 MB." }) }),
      {
        file_path: "doc.pdf",
      },
    );
    expect(out.status).toBe("error");
    expect(text(out)).toBe("Images and documents already take 19 MB.");
  });

  // spec: AC-TOOLS-02
  test("a PDF over the provider's page cap is read as text instead", async () => {
    const cwd = await withPdf(numberedPdf(5));
    const out = await read(context(cwd, { media: media({ pdfMaxPages: 3 }) }), { file_path: "doc.pdf", pages: "1-4" });
    expect(documentOf(out)).toBeUndefined();
    expect(text(out)).toContain("Page 4 of 5");
  });
});

describe("Read: PDFs as text", () => {
  // spec: AC-TOOLS-02
  test("a model without PDF input gets the text of the pages, one heading per page", async () => {
    const cwd = await withPdf(numberedPdf(30));
    const out = await read(context(cwd, { media: media({ pdfs: false }) }), { file_path: "doc.pdf", pages: "2-3" });
    expect(out.status).toBe("ok");
    expect(documentOf(out)).toBeUndefined();
    const body = text(out);
    expect(body).toContain("--- Page 2 ---\nPage 2 of 30\nbody line 1");
    expect(body).toContain("--- Page 3 ---\nPage 3 of 30");
    expect(body).not.toContain("Page 1 of 30");
    expect(body).not.toContain("Page 4 of 30");
  });

  // spec: AC-TOOLS-02
  test("a context with no media at all still reads the text", async () => {
    const cwd = await withPdf(numberedPdf(3));
    const out = await read(context(cwd), { file_path: "doc.pdf" });
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("--- Page 3 ---\nPage 3 of 3");
  });

  // spec: AC-TOOLS-02
  test("a 30-page PDF without pages names pages here too", async () => {
    const cwd = await withPdf(numberedPdf(30));
    const out = await read(context(cwd), { file_path: "doc.pdf" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("pass pages");
  });

  // spec: AC-TOOLS-02
  test("read.maxTokens sets how many pages fit whole (3,000 tokens each)", async () => {
    const cwd = await withPdf(numberedPdf(3));
    const ctx = context(cwd, { settings: Settings.parse({ read: { maxTokens: 6000 } }) });
    const refused = await read(ctx, { file_path: "doc.pdf" });
    expect(refused.status).toBe("error");
    expect(text(refused)).toContain("at most 2 pages");
    expect((await read(ctx, { file_path: "doc.pdf", pages: "1-2" })).status).toBe("ok");
    expect((await read(ctx, { file_path: "doc.pdf", pages: "1-3" })).status).toBe("error");
  });

  // spec: AC-TOOLS-02
  test("a page with no text says so, because the model cannot view pages", async () => {
    const cwd = await withPdf(testPdf(["", "second page"]));
    const out = await read(context(cwd, { media: media({ pdfs: false }) }), { file_path: "doc.pdf" });
    expect(text(out)).toContain(
      "--- Page 1 ---\n[No text on this page (a scan or a picture). This model can't view PDF pages.]",
    );
    expect(text(out)).toContain("--- Page 2 ---\nsecond page");
  });

  // spec: AC-TOOLS-02
  test("text over the token limit is cut with a notice, whole pages first", async () => {
    const cwd = await workspace();
    const dense = (tag: string, lines: number): string =>
      Array.from({ length: lines }, (_, i) => `${tag} line ${i} ${"word ".repeat(10)}`).join("\n");
    await writeFile(join(cwd, "one.pdf"), testPdf([dense("A", 300)]));
    await writeFile(join(cwd, "two.pdf"), testPdf([dense("A", 180), dense("B", 180)]));
    const small = context(cwd, { settings: Settings.parse({ read: { maxTokens: 3000 } }) });

    const one = text(await read(small, { file_path: "one.pdf" }));
    expect(one).toContain("[PARTIAL view: page 1 is longer than the read limit");
    expect(one.length).toBeLessThan(3000 * 3.5 + 600);

    const wide = context(cwd, { settings: Settings.parse({ read: { maxTokens: 6000 } }) });
    const both = text(await read(wide, { file_path: "two.pdf" }));
    expect(both).toContain(
      '[PARTIAL view: pages 1–1 of the 1–2 you asked for fit the read limit. Continue with pages="2-2".]',
    );
    expect(both).not.toContain("--- Page 2 ---");
  });

  // spec: AC-TOOLS-02
  test("an unchanged re-read of the same pages is deduplicated", async () => {
    const cwd = await withPdf(numberedPdf(3));
    const first = text(await read(context(cwd), { file_path: "doc.pdf" }));
    const seen = { turn: 4, sha256: new Bun.CryptoHasher("sha256").update(first).digest("hex"), dedup: false };
    const ctx = context(cwd, { readResults: { lookup: () => seen } });
    expect(text(await read(ctx, { file_path: "doc.pdf" }))).toStartWith("File unchanged since your Read in turn 4");
  });

  // spec: AC-TOOLS-02
  test("hidden-instruction characters in the text are removed and taint the session", async () => {
    const cwd = await withPdf(testPdf(["before ~ after"], { tildeAs: "\u{E0041}x" }));
    const out = await read(context(cwd), { file_path: "doc.pdf" });
    expect(text(out)).toContain("before ⟨1 hidden characters removed⟩x after");
    expect(text(out)).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
    expect(out.meta?.effects).toEqual([{ kind: "taint", source: expect.stringContaining("doc.pdf") }]);
  });
});

describe("Read: PDF errors", () => {
  // spec: AC-TOOLS-02
  test("a list of pages is refused", async () => {
    const cwd = await withPdf(numberedPdf(30));
    const out = await read(context(cwd), { file_path: "doc.pdf", pages: "6,9,15" });
    expect(text(out)).toBe("Read one page or range per call.");
  });

  // spec: AC-TOOLS-02
  test.each([
    ["0", "page numbers start at 1"],
    ["abc", 'pages must be one page like "3" or one range like "1-5"'],
    ["5-2", "ends before it starts"],
    ["28-31", "has 30 pages"],
    ["31", "has 30 pages"],
    ["1-9", "at most 8 pages"],
  ])("pages %p is refused: %s", async (pages, why) => {
    const cwd = await withPdf(numberedPdf(30));
    const out = await read(context(cwd, { media: media() }), { file_path: "doc.pdf", pages });
    expect(out.status).toBe("error");
    expect(text(out)).toContain(why);
  });

  // spec: AC-TOOLS-02
  test("a file that is not a PDF is refused with the reason", async () => {
    const cwd = await withPdf(new TextEncoder().encode("this is not a pdf"));
    const out = await read(context(cwd), { file_path: "doc.pdf" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("could not be read as a PDF");
  });

  // spec: AC-TOOLS-02
  test("a truncated PDF is refused", async () => {
    const cwd = await withPdf(numberedPdf(10).subarray(0, 700));
    const out = await read(context(cwd), { file_path: "doc.pdf" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("could not be read as a PDF");
  });

  // spec: AC-TOOLS-02
  test("a password-protected PDF says so", async () => {
    const cwd = await withPdf(ENCRYPTED_PDF);
    const out = await read(context(cwd, { media: media() }), { file_path: "doc.pdf" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("password-protected");
    expect(documentOf(out)).toBeUndefined();
  });

  // spec: AC-TOOLS-02
  test("a PDF over 30 MB is not read", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "big.pdf"), new Uint8Array(31 * 1024 * 1024));
    const out = await read(context(cwd), { file_path: "big.pdf" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("PDFs over 30 MB are not read");
  });

  // spec: AC-TOOLS-02
  test("reading stops when the turn is cancelled", async () => {
    const cwd = await withPdf(numberedPdf(8));
    const controller = new AbortController();
    controller.abort();
    const out = await read(context(cwd, { signal: controller.signal }), { file_path: "doc.pdf" });
    expect(out.status).toBe("interrupted");
  });
});
