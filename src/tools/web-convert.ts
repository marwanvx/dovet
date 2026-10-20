// WebFetch conversion (tools §9): HTML to Markdown through Readability and Turndown, with a tag-stripping fallback.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { stripHidden } from "./hidden.ts";

export const MAX_HTML_CHARS = 5_000_000;
export const CONVERSION_BUDGET_MS = 10_000;

export type Converted = { markdown: string; note?: string };

const SKIPPED = ["script", "style", "noscript", "svg"];
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Linear in the input: finds each tag with `indexOf`, never a backtracking pattern. */
export function stripTags(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const name = /^<([a-z][a-z0-9]*)/.exec(lower.slice(lt, lt + 12))?.[1];
    if (name !== undefined && SKIPPED.includes(name)) {
      const close = lower.indexOf(`</${name}`, lt);
      const end = close < 0 ? -1 : html.indexOf(">", close);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const gt = html.indexOf(">", lt);
    out.push(name === undefined ? "<" : "\n");
    i = name === undefined ? lt + 1 : gt < 0 ? html.length : gt + 1;
  }
  return decodeEntities(out.join(""))
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, n, all) => l !== "" || all[n - 1] !== "")
    .join("\n")
    .trim();
}

function clean(markdown: string): string {
  return stripHidden(markdown)
    .text.replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToMarkdown(html: string, now: () => number = Date.now): Converted {
  if (html.length > MAX_HTML_CHARS)
    return {
      markdown: clean(stripTags(html)),
      note: "(The page is over 5 MB, so it was reduced to plain text instead of converted to Markdown.)",
    };
  const started = now();
  const late = (): boolean => now() - started > CONVERSION_BUDGET_MS;
  const fallback = (why: string): Converted => ({
    markdown: clean(stripTags(html)),
    note: `(${why}, so the page was reduced to plain text instead of converted to Markdown.)`,
  });
  try {
    const { document } = parseHTML(html);
    for (const node of document.querySelectorAll(SKIPPED.join(","))) node.remove();
    if (late()) return fallback("Parsing took longer than 10 s");
    const article = new Readability(document, { keepClasses: false }).parse();
    if (late()) return fallback("Extracting the article took longer than 10 s");
    const body = article?.content ?? document.body?.innerHTML ?? "";
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    const markdown = clean(turndown.turndown(body));
    if (late()) return fallback("Conversion took longer than 10 s");
    return { markdown: markdown === "" ? clean(stripTags(html)) : markdown };
  } catch (e) {
    return fallback(`The page could not be parsed (${e instanceof Error ? e.message : String(e)})`);
  }
}
