// `.env` file parsing, shared by the shell environment and the redaction set.
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(line);
    if (!m?.[1] || m[2] === undefined) continue;
    const key = m[1];
    let valPart = m[2].trim();

    if (valPart.startsWith('"') || valPart.startsWith("'")) {
      const quote = valPart[0];
      let val = "";
      let closed = false;
      let current = valPart.slice(1);
      for (;;) {
        let quoteIdx = -1;
        for (let c = 0; c < current.length; c++) {
          if (quote === '"' && current[c] === "\\" && c + 1 < current.length) {
            c++;
            continue;
          }
          if (current[c] === quote) {
            quoteIdx = c;
            break;
          }
        }
        if (quoteIdx >= 0) {
          val += current.slice(0, quoteIdx);
          closed = true;
          break;
        }
        val += `${current}\n`;
        if (i >= lines.length) break;
        const nextLine = lines[i];
        if (nextLine === undefined) break;
        current = nextLine;
        i++;
      }
      if (closed) {
        if (quote === '"') {
          val = val
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
        }
        result[key] = val;
      } else {
        result[key] = valPart;
      }
    } else {
      const commentIdx = valPart.search(/\s+#|^#/);
      if (commentIdx >= 0) valPart = valPart.slice(0, commentIdx).trim();
      result[key] = valPart;
    }
  }
  return result;
}
