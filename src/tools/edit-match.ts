// Edit's matching cascade (tools §3 step 6) on LF-normalized text: exact, line-number-prefix strip, indentation-tolerant.
// Matching is literal search and line comparison, never a regex built from model text.

export type MatchLevel = "exact" | "prefix-strip" | "indent";
export type Applied = {
  kind: "applied";
  text: string;
  level: MatchLevel;
  count: number;
  /** First changed line (1-based) and how many lines it now spans. */
  line: number;
  span: number;
};
export type Outcome = Applied | { kind: "many"; lines: number[] } | { kind: "none" };

const INDENT_UNITS = [4, 2, 8];
const PREFIX = /^\d+\t/;
const MAX_CELLS = 4_000_000;
const MAX_CANDIDATES = 500;

export const SIMILARITY = 0.9;

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;
const bodyLines = (s: string): string[] => {
  const lines = s.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};
const leading = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? "";
const width = (ws: string, unit: number): number => [...ws].reduce((n, c) => n + (c === "\t" ? unit : 1), 0);

function findAll(text: string, needle: string): number[] {
  const starts: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) starts.push(i);
  return starts;
}

export function applyExact(text: string, oldText: string, newText: string, all: boolean, level: MatchLevel): Outcome {
  const starts = findAll(text, oldText);
  const [first] = starts;
  if (first === undefined) return { kind: "none" };
  if (starts.length > 1 && !all) return { kind: "many", lines: starts.map((s) => lineOf(text, s)) };
  const out = all
    ? text.split(oldText).join(newText)
    : text.slice(0, first) + newText + text.slice(first + oldText.length);
  return {
    kind: "applied",
    text: out,
    level,
    count: starts.length,
    line: lineOf(text, first),
    span: newText === "" ? 0 : bodyLines(newText).length,
  };
}

function stripPrefixes(s: string): string | undefined {
  const body = bodyLines(s);
  if (body.length === 0 || !body.every((l) => PREFIX.test(l))) return undefined;
  return s
    .split("\n")
    .map((l) => l.replace(PREFIX, ""))
    .join("\n");
}

/** Index pairs of a longest common subsequence of two line lists. */
export function commonLines(a: string[], b: string[]): Array<[number, number]> {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const pairs: Array<[number, number]> = Array.from({ length: head }, (_, i) => [i, i]);
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length * bm.length <= MAX_CELLS) {
    const w = bm.length + 1;
    const table = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--)
      for (let j = bm.length - 1; j >= 0; j--)
        table[i * w + j] =
          am[i] === bm[j]
            ? (table[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * w + j] ?? 0, table[i * w + j + 1] ?? 0);
    for (let i = 0, j = 0; i < am.length && j < bm.length; ) {
      if (am[i] === bm[j]) pairs.push([head + i++, head + j++]);
      else if ((table[(i + 1) * w + j] ?? 0) >= (table[i * w + j + 1] ?? 0)) i++;
      else j++;
    }
  }
  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

type IndentMatch = { start: number; offset: number; unit: number };

function indentMatches(file: string[], old: string[]): IndentMatch[] {
  const found = new Map<number, IndentMatch>();
  for (const unit of INDENT_UNITS) {
    for (let s = 0; s + old.length <= file.length; s++) {
      if (found.has(s)) continue;
      let offset: number | undefined;
      let ok = true;
      for (let j = 0; j < old.length && ok; j++) {
        const f = (file[s + j] ?? "").trimEnd();
        const o = (old[j] ?? "").trimEnd();
        if (o === "" || f === "") {
          ok = o === f;
          continue;
        }
        const fl = leading(f);
        const ol = leading(o);
        const diff = width(fl, unit) - width(ol, unit);
        ok = f.slice(fl.length) === o.slice(ol.length) && (offset === undefined || offset === diff);
        offset ??= diff;
      }
      if (ok && offset !== undefined) found.set(s, { start: s, offset, unit });
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

function applyIndent(text: string, oldText: string, newText: string): Outcome {
  const file = text.split("\n");
  const old = bodyLines(oldText);
  const hits = indentMatches(file, old);
  const [hit] = hits;
  if (hit === undefined) return { kind: "none" };
  if (hits.length > 1) return { kind: "many", lines: hits.map((h) => h.start + 1) };
  const next = newText === "" ? [] : bodyLines(newText);
  const kept = new Map(commonLines(old, next).map(([i, j]) => [j, i]));
  const tabs = file.filter((l) => l.startsWith("\t")).length > file.filter((l) => l.startsWith(" ")).length;
  const reindent = (line: string): string => {
    if (line.trim() === "") return line;
    const lead = leading(line);
    const w = Math.max(0, width(lead, hit.unit) + hit.offset);
    const ws = tabs ? "\t".repeat(Math.floor(w / hit.unit)) + " ".repeat(w % hit.unit) : " ".repeat(w);
    return ws + line.slice(lead.length);
  };
  const replaced = next.map((line, k) => {
    const from = kept.get(k);
    return from === undefined ? reindent(line) : (file[hit.start + from] ?? line);
  });
  const out = [...file.slice(0, hit.start), ...replaced, ...file.slice(hit.start + old.length)].join("\n");
  return { kind: "applied", text: out, level: "indent", count: 1, line: hit.start + 1, span: replaced.length };
}

/** L0, then L1 and L2 only when every stricter level found nothing (replace_all uses L0 only). */
export function applyEdit(text: string, oldText: string, newText: string, all: boolean): Outcome {
  const exact = applyExact(text, oldText, newText, all, "exact");
  if (exact.kind !== "none" || all) return exact;
  const oldStripped = stripPrefixes(oldText);
  if (oldStripped !== undefined) {
    const stripped = applyExact(text, oldStripped, stripPrefixes(newText) ?? newText, false, "prefix-strip");
    if (stripped.kind !== "none") return stripped;
  }
  return applyIndent(text, oldText, newText);
}

function similarity(a: string, b: string): number {
  if (a.length * b.length > MAX_CELLS) return 0;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++)
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    [prev, cur] = [cur, prev];
  }
  const total = a.length + b.length;
  return total === 0 ? 1 : (2 * (prev[b.length] ?? 0)) / total;
}

export type Closest = { first: number; last: number; percent: number; diff: string };

/** The file region most like `oldText` (similarity ≥ 0.9), with a line diff, for the not-found error. */
export function closestMatch(text: string, oldText: string): Closest | undefined {
  const file = text.split("\n");
  const old = bodyLines(oldText);
  const byContent = new Map<string, number[]>();
  file.forEach((l, i) => {
    const key = l.trim();
    if (key !== "") byContent.set(key, [...(byContent.get(key) ?? []), i]);
  });
  const starts = new Set<number>();
  old.forEach((l, j) => {
    for (const i of byContent.get(l.trim()) ?? [])
      if (i - j >= 0 && i - j + old.length <= file.length) starts.add(i - j);
  });
  const want = old.join("\n");
  let best: { start: number; ratio: number } | undefined;
  for (const start of [...starts].sort((a, b) => a - b).slice(0, MAX_CANDIDATES)) {
    const ratio = similarity(want, file.slice(start, start + old.length).join("\n"));
    if (ratio >= SIMILARITY && (best === undefined || ratio > best.ratio)) best = { start, ratio };
  }
  if (best === undefined) return undefined;
  const region = file.slice(best.start, best.start + old.length);
  const pairs = commonLines(old, region);
  const diff: string[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [old.length, region.length] as [number, number]]) {
    while (i < pi) diff.push(`- ${old[i++]}`);
    while (j < pj) diff.push(`+ ${region[j++]}`);
    if (pi < old.length) diff.push(`  ${old[i]}`);
    i++;
    j++;
  }
  return {
    first: best.start + 1,
    last: best.start + old.length,
    percent: Math.min(99, Math.round(best.ratio * 100)),
    diff: diff.join("\n"),
  };
}
