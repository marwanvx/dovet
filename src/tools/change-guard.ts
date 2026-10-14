// What a whole-file change adds and removes, and the placeholder guard shared by Write and Edit (tools §2 step 4).

const MARKERS = [
  /(\.\.\.|…)\s*(rest|remaining|existing|other|previous|unchanged|same)\b/i,
  /\b(rest|remainder) of (the )?(code|file|implementation|function|class)\b/i,
  /\b(code|implementation) (unchanged|remains the same|as before)\b/i,
];
const MIN_REMOVED = 10;

const splitLines = (s: string): string[] => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Lines left after trimming the common head and tail; an approximation of a diff that is exact for one contiguous edit. */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

export function placeholderViolation(before: string, after: string): string | undefined {
  if (lineDelta(before, after).removed < MIN_REMOVED) return undefined;
  for (const line of splitLines(after)) {
    const marker = MARKERS.map((re) => re.exec(line)?.[0]).find((m) => m !== undefined);
    if (marker !== undefined && !before.includes(marker))
      return `The new content contains "${line.trim()}" where existing code was removed. Write the complete content, or use Edit to change only the part you mean.`;
  }
  return undefined;
}
