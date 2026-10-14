// Cleaning command output for the model (tools §5.5).
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  "g",
);
const CONTROL = "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f";
const BINARY_RUN = new RegExp(`[${CONTROL}]*\\u0000[${CONTROL}]*`, "g");
export const MAX_LINE = 5000;

export function sanitizeOutput(raw: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(raw).replace(ANSI, "").replace(/\r\n/g, "\n");
  return text
    .replace(BINARY_RUN, (run) => `[binary output, ${run.length} bytes]`)
    .split("\n")
    .map((line) => {
      const shown = line.includes("\r") ? (line.split("\r").findLast((s) => s !== "") ?? "") : line;
      if (shown.length <= MAX_LINE) return shown;
      const half = MAX_LINE / 2;
      return `${shown.slice(0, half)}… [${shown.length - MAX_LINE} chars cut] …${shown.slice(-half)}`;
    })
    .join("\n")
    .replace(/\n+$/, "");
}

export function headAndTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… [${text.length - limit} chars cut] …\n${text.slice(-half)}`;
}
