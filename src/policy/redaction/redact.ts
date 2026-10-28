// Output redaction (permissions §8): secret values, key formats and URL passwords in tool results.
import { MIN_SECRET_VALUE_LENGTH, type NamedSecret } from "./secrets.ts";

const MARKER = "[REDACTED:";

const FORMATS: Array<{ re: RegExp; marker: string }> = [
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g, marker: "[REDACTED:ANTHROPIC_KEY]" },
  { re: /sk-or-[A-Za-z0-9_-]{8,}/g, marker: "[REDACTED:OPENROUTER_KEY]" },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, marker: "[REDACTED:OPENAI_KEY]" },
  { re: /AIza[0-9A-Za-z_-]{20,}/g, marker: "[REDACTED:GOOGLE_API_KEY]" },
  { re: /gh[pougs]_[A-Za-z0-9]{16,}/g, marker: "[REDACTED:GITHUB_TOKEN]" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, marker: "[REDACTED:GITHUB_TOKEN]" },
  { re: /glpat-[A-Za-z0-9_-]{8,}/g, marker: "[REDACTED:GITLAB_TOKEN]" },
  { re: /xox[abpr]-[A-Za-z0-9-]{8,}/g, marker: "[REDACTED:SLACK_TOKEN]" },
  { re: /A[KS]IA[0-9A-Z]{16}/g, marker: "[REDACTED:AWS_ACCESS_KEY_ID]" },
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    marker: "[REDACTED:PRIVATE_KEY]",
  },
  {
    re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/g,
    marker: "[REDACTED:JWT]",
  },
];

const URL_WITH_AUTHORITY = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+/g;

/** Zero-width characters that camouflage a key without changing how it reads. */
const isCamouflage = (ch: string): boolean => ch === "\u200B" || ch === "\u200C" || ch === "\u200D" || ch === "\uFEFF";

type Span = { start: number; end: number; marker: string };

function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    if (!isCamouflage(ch)) {
      folded += ch;
      for (let j = 0; j < ch.length; j++) {
        map.push(i + j);
      }
    }
    i += ch.length;
  }
  return { folded, map };
}

function urlPasswordSpans(folded: string): Span[] {
  const out: Span[] = [];
  for (const m of folded.matchAll(URL_WITH_AUTHORITY)) {
    const base = m.index ?? 0;
    const auth = m[0].slice(m[0].indexOf("://") + 3);
    const at = auth.lastIndexOf("@");
    if (at < 0) continue;
    const colon = auth.slice(0, at).indexOf(":");
    if (colon < 0) continue;
    const start = base + m[0].length - auth.length + colon + 1;
    const end = base + m[0].length - auth.length + at;
    if (end <= start || folded.slice(start, end).includes(MARKER)) continue;
    out.push({ start, end, marker: "[REDACTED:URL_PASSWORD]" });
  }
  return out;
}

/** Redacts secret values, known key formats and URL passwords. Persian/ZWJ text without secrets is untouched. */
export function redactText(text: string, secrets: readonly NamedSecret[]): string {
  const { folded, map } = fold(text);
  const spans: Span[] = [];
  const ordered = [...secrets]
    .filter((s) => s.value.length >= MIN_SECRET_VALUE_LENGTH)
    .sort((a, b) => b.value.length - a.value.length);
  for (const s of ordered) {
    let at = folded.indexOf(s.value);
    while (at >= 0) {
      const segment = s.plain === true && (folded[at - 1] === "/" || folded[at - 1] === "\\");
      if (!segment) spans.push({ start: at, end: at + s.value.length, marker: `[REDACTED:${s.name}]` });
      at = folded.indexOf(s.value, at + s.value.length);
    }
  }
  for (const f of FORMATS) {
    f.re.lastIndex = 0;
    for (const m of folded.matchAll(f.re)) {
      const start = m.index ?? 0;
      spans.push({ start, end: start + m[0].length, marker: f.marker });
    }
  }
  spans.push(...urlPasswordSpans(folded));
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  let covered = 0;
  for (const s of spans) {
    const start = map[s.start] ?? text.length;
    const end = s.end < map.length ? (map[s.end] ?? text.length) : text.length;
    if (start < covered) {
      if (end > covered) cursor = covered = end;
      continue;
    }
    out += text.slice(cursor, start) + s.marker;
    cursor = end;
    covered = end;
  }
  return out + text.slice(cursor);
}
