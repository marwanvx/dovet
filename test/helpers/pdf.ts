// Generated PDF fixtures for the Read tests: a plain text PDF written by hand, no PDF library involved.

export type TestPdfOptions = {
  /** Maps the glyph for "~" to these code points when text is extracted (a ToUnicode map), to carry characters WinAnsi cannot. */
  tildeAs?: string;
};

const pdfString = (line: string): string => line.replace(/[\\()]/g, (c) => `\\${c}`);

/** One page per entry; "\n" starts a new line; an empty entry is a page with no text (a scan). */
export function testPdf(pages: readonly string[], options: TestPdfOptions = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  if (options.tildeAs !== undefined) {
    const utf16 = [...options.tildeAs]
      .map((c) => {
        const cp = c.codePointAt(0) ?? 0;
        if (cp < 0x10000) return cp.toString(16).padStart(4, "0");
        const v = cp - 0x10000;
        return (0xd800 + (v >> 10)).toString(16) + (0xdc00 + (v & 0x3ff)).toString(16);
      })
      .join("");
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <7E> <${utf16}> endbfchar endcmap end end`;
    const stream = add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
    objects[font - 1] =
      `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode ${stream} 0 R >>`;
  }
  const kids: number[] = [];
  for (const text of pages) {
    const lines = text === "" ? [] : text.split("\n");
    const height = Math.max(792, lines.length * 14 + 144);
    const body = `BT /F1 12 Tf 72 ${height - 72} Td 14 TL ${lines.map((l) => `(${pdfString(l)}) Tj T*`).join(" ")} ET`;
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** `count` pages whose first line is "Page <n> of <count>" followed by `lines` filler lines. */
export function numberedPdf(count: number, lines = 3): Uint8Array {
  return testPdf(
    Array.from({ length: count }, (_, i) =>
      [`Page ${i + 1} of ${count}`, ...Array.from({ length: lines }, (_, l) => `body line ${l + 1}`)].join("\n"),
    ),
  );
}

/** One page saying "secret", encrypted with a user password (made with Ghostscript's pdfwrite). */
export const ENCRYPTED_PDF = Uint8Array.from(
  Buffer.from(
    "JVBERi0xLjcKJcfsj6IKJSVJbnZvY2F0aW9uOiBncyAtcSAtZEJBVENIIC1kTk9QQVVTRSAtc0RFVklDRT1wZGZ3cml0ZSAtc093bmVyUGFzc3dvcmQ9PyAtc1VzZXJQYXNzd29yZD0/IC1zT3V0cHV0RmlsZT0/ID8KNSAwIG9iago8PC9MZW5ndGggNiAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+CnN0cmVhbQppYGkXtLIEMMvh2D/5Yh4ViJvvtqRFaTWpB1X6NweeFHWeRZY8fHLxt5sSNofaRf7/zOqaS5Wn1EeMuFsi0wTHpM+xTQPqxw/eoGmIAHLGZW5kc3RyZWFtCmVuZG9iago0IDAgb2JqCjw8L1R5cGUvUGFnZS9NZWRpYUJveCBbMCAwIDYxMiA3OTJdCi9Sb3RhdGUgMC9QYXJlbnQgMyAwIFIKL1Jlc291cmNlczw8L1Byb2NTZXRbL1BERiAvVGV4dF0KL0ZvbnQgOSAwIFIKPj4KL0NvbnRlbnRzIDUgMCBSCj4+CmVuZG9iagozIDAgb2JqCjw8IC9UeXBlIC9QYWdlcyAvS2lkcyBbCjQgMCBSCl0gL0NvdW50IDEKPj4KZW5kb2JqCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMyAwIFIKL01ldGFkYXRhIDExIDAgUgo+PgplbmRvYmoKMTAgMCBvYmoKPDwvRmlsdGVyL0ZsYXRlRGVjb2RlL0xlbmd0aCAxODk+PnN0cmVhbQrbf4185JW5EDVq4oTIDCWT9jBmMioCp2irlXZEbpu9J047kk8zLsDnO3A9C3cNKaiJdL2mey1AtDmcMbJ3koW06Gi1Cs85VNfqsFrlgNtgJVi68HpApsQqvXkypDUwnYqKH8jS3mdcw0qwsRQ6XhiUBzDxQ7VzUM+MVOjhrCOCljbaFkzpDvrYfAWIn9c6StMADicRgt5U19CJkeeBnnqLhuMCbCH5cFZUHO4Dnkk26aCB2YDcoAo0iMdBYiUKZW5kc3RyZWFtCmVuZG9iagoxMSAwIG9iago8PC9UeXBlL01ldGFkYXRhCi9TdWJ0eXBlL1hNTC9MZW5ndGggMTQ1Mz4+c3RyZWFtCjw/eHBhY2tldCBiZWdpbj0n77u/JyBpZD0nVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkJz8+Cjw/YWRvYmUteGFwLWZpbHRlcnMgZXNjPSJDUkxGIj8+Cjx4OnhtcG1ldGEgeG1sbnM6eD0nYWRvYmU6bnM6bWV0YS8nIHg6eG1wdGs9J1hNUCB0b29sa2l0IDIuOS4xLTEzLCBmcmFtZXdvcmsgMS42Jz4KPHJkZjpSREYgeG1sbnM6cmRmPSdodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjJyB4bWxuczppWD0naHR0cDovL25zLmFkb2JlLmNvbS9pWC8xLjAvJz4KPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6cGRmPSdodHRwOi8vbnMuYWRvYmUuY29tL3BkZi8xLjMvJyBwZGY6UHJvZHVjZXI9J0dQTCBHaG9zdHNjcmlwdCAxMC4wNi4wJy8+CjxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOnhtcD0naHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyc+PHhtcDpNb2RpZnlEYXRlPjIwMjYtMTAtMjFUMDI6Mzg6NTkrMDM6MDA8L3htcDpNb2RpZnlEYXRlPgo8eG1wOkNyZWF0ZURhdGU+MjAyNi0xMC0yMVQwMjozODo1OSswMzowMDwveG1wOkNyZWF0ZURhdGU+Cjx4bXA6TWV0YWRhdGFEYXRlPjIwMjYtMTAtMjFUMDI6Mzg6NTkrMDM6MDA8L3htcDpNZXRhZGF0YURhdGU+Cjx4bXA6Q3JlYXRvclRvb2w+VW5rbm93bkFwcGxpY2F0aW9uPC94bXA6Q3JlYXRvclRvb2w+PC9yZGY6RGVzY3JpcHRpb24+CjxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOnhtcE1NPSdodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vJyB4bXBNTTpEb2N1bWVudElEPSd1dWlkOmY5MTRmMDkzLTA0ZmItMTFmZC0wMDAwLWE3NjEwYjM4YWEzOCcvPgo8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXBNTT0naHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLycgeG1wTU06UmVuZGl0aW9uQ2xhc3M9J2RlZmF1bHQnLz4KPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wTU09J2h0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8nIHhtcE1NOlZlcnNpb25JRD0nMScvPgo8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczpkYz0naHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8nIGRjOmZvcm1hdD0nYXBwbGljYXRpb24vcGRmJz48ZGM6dGl0bGU+PHJkZjpBbHQ+PHJkZjpsaSB4bWw6bGFuZz0neC1kZWZhdWx0Jz5VbnRpdGxlZDwvcmRmOmxpPjwvcmRmOkFsdD48L2RjOnRpdGxlPjwvcmRmOkRlc2NyaXB0aW9uPgo8L3JkZjpSREY+CjwveDp4bXBtZXRhPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCjw/eHBhY2tldCBlbmQ9J3cnPz4KZW5kc3RyZWFtCmVuZG9iago4IDAgb2JqCjw8L0ZpbHRlci9GbGF0ZURlY29kZQovVHlwZS9PYmpTdG0KL04gNAovRmlyc3QgMTgvTGVuZ3RoIDE2Nz4+c3RyZWFtCrPjJI38obFpC5HMXl1vITTheE4NZW9RZSvSOOF0GqoCEmVA+/BdOtSdJo72KuNdlkNzuFRbnPaLiZKK2NOI8jGlZWfYSiWKLFYr/R2vb1DIMzWs0AqLLCHRam02RWcm8g2JMHHhrz2mzWc21K0Fz9aNy5gvVysh7qguxX+a2z52V72G4hDzuA2JLN6ZWnGY7/ZtPstiHmr2XawZiZp5FLm1aFcFr0KZCmVuZHN0cmVhbQplbmRvYmoKMTIgMCBvYmoKPDwvRmlsdGVyIC9TdGFuZGFyZCAvViAxIC9MZW5ndGggNDAgL1IgMiAvUCAtNCAvTyAohT/uP2VQ/DvCEnl+rtmcyb5TNHWDpzjiX9+xJCv5M2YpCi9VICiQcR5hGvt3dZSEZIh9AtWbr4GbIF2PK7uD0RVTboPZuSk+PgplbmRvYmoKMTMgMCBvYmoKPDwKL1R5cGUgL1hSZWYKL1NpemUgMTQKL1Jvb3QgMSAwIFIgL0luZm8gMiAwIFIKL0lEIFs8QkFDRUNGNjM3RDFGRDU5QTk1QkY0OTYxQjA3NjY4M0M+PEJBQ0VDRjYzN0QxRkQ1OUE5NUJGNDk2MUIwNzY2ODNDPl0KL0VuY3J5cHQgMTIgMCBSIC9JbmRleCBbMCAxNCBdCi9XIFsxIDIgMl0KL0ZpbHRlciAvRmxhdGVEZWNvZGUvTGVuZ3RoIDU5Cj4+CnN0cmVhbQp4nGNgYPj/n5HxBgMDEwMHAzMj41wGBkZGASDBUA0RAxNMjJwiEBYjI5MkUJZZCkhwgYnlDAwABMsFYwplbmRzdHJlYW0KZW5kb2JqCnN0YXJ0eHJlZgoyNzI3CiUlRU9GCg==",
    "base64",
  ),
);
