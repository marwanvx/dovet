// Instruction-file text processing (context §3 "Imports", "Processing", path-scoped rules).
import { YAML } from "bun";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function* proseLines(text: string): Generator<{ line: string; start: number; prose: boolean }> {
  let fence: string | undefined;
  let start = 0;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    const inFence = fence !== undefined;
    if (marker !== undefined && (fence === undefined || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === undefined ? marker : undefined;
    }
    yield { line, start, prose: !inFence && marker === undefined };
    start += line.length + 1;
  }
}

/** Block-level `<!-- … -->` comments go; comments inside code blocks or after text on a line stay. */
export function stripHtmlComments(text: string): string {
  const out: string[] = [];
  let inComment = false;
  for (const { line, prose } of proseLines(text)) {
    let rest = line;
    if (!inComment && prose && /^ {0,3}<!--/.test(line)) {
      inComment = true;
      rest = line.replace(/^ {0,3}<!--/, "");
    }
    if (!inComment) {
      out.push(line);
      continue;
    }
    const end = rest.indexOf("-->");
    if (end === -1) continue;
    inComment = false;
    const after = rest.slice(end + 3);
    if (after.trim() !== "") out.push(after);
  }
  return out.join("\n");
}

export type ImportRef = { index: number; length: number; path: string };

/** `@path` at a line start or after whitespace, outside code spans and fenced blocks; the path ends at whitespace. */
export function findImports(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const { line, start, prose } of proseLines(text)) {
    if (!prose) continue;
    const masked = line.replace(/(`+)[^`]*?\1(?!`)/g, (span) => " ".repeat(span.length));
    for (const m of masked.matchAll(/(^|\s)@(\S+)/g)) {
      const index = start + m.index + (m[1]?.length ?? 0);
      refs.push({ index, length: (m[2]?.length ?? 0) + 1, path: m[2] ?? "" });
    }
  }
  return refs;
}

/** How many patterns `{a,b}` groups expand to, without expanding them. */
export function braceExpansions(pattern: string): number {
  let i = 0;
  const sequence = (): number => {
    let total = 1;
    while (i < pattern.length && pattern[i] !== "," && pattern[i] !== "}") {
      if (pattern[i] === "\\") i += 2;
      else if (pattern[i] === "{") {
        i++;
        let alternatives = sequence();
        while (pattern[i] === ",") {
          i++;
          alternatives += sequence();
        }
        i++;
        total *= alternatives;
      } else i++;
    }
    return total;
  };
  let total = sequence();
  while (i < pattern.length) {
    i++;
    total *= sequence();
  }
  return total;
}

const MAX_EXPANSIONS = 1000;

export type RuleText = { body: string; paths?: string[]; warning?: string };

/** `paths` is the only frontmatter key read; anything wrong with it means an unscoped rule and a warning. */
export function parseRule(text: string): RuleText {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (m === null) return { body: text };
  const body = text.slice(m[0].length);
  let data: unknown;
  try {
    data = YAML.parse(m[1] ?? "");
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return { body, warning: "invalid YAML frontmatter; loaded as an unscoped rule" };
  }
  const raw = data !== null && typeof data === "object" && "paths" in data ? data.paths : undefined;
  if (raw === undefined) return { body };
  const paths = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === "string")) {
    return { body, warning: "`paths` must be a list of glob patterns; loaded as an unscoped rule" };
  }
  if (paths.reduce((n, p) => n + braceExpansions(p), 0) > MAX_EXPANSIONS) {
    return { body, warning: "`paths` expands to more than 1,000 patterns; loaded as an unscoped rule" };
  }
  return { body, paths };
}

/** gitignore-style: a pattern without a slash matches at any depth, a leading slash anchors it, a match covers a directory's contents. */
export function excludeMatcher(
  patterns: readonly string[],
): (relative: string | undefined, absolute: string) => boolean {
  const globs = patterns.flatMap((raw) => {
    let p = raw.replace(/\/+$/, "");
    if (p === "") return [];
    if (!p.includes("/")) p = `**/${p}`;
    p = p.replace(/^\//, "");
    return [new Bun.Glob(p), new Bun.Glob(`${p}/**`)];
  });
  return (relative, absolute) => {
    const candidates = [absolute.replaceAll("\\", "/").replace(/^\//, "")];
    if (relative !== undefined) candidates.push(relative.replaceAll("\\", "/"));
    return globs.some((g) => candidates.some((c) => g.match(c)));
  };
}
