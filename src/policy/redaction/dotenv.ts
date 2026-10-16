// `.env` file parsing, shared by the shell environment and the redaction set.
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    result[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return result;
}
