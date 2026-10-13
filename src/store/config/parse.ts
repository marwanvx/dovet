import { findNodeAtLocation, type Node, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import { SettingsError } from "./errors.ts";

export type Parsed = { value: unknown; tree: Node | undefined };
export type Segment = string | number;

/** Own properties only, so a `__proto__` key stays data instead of changing the prototype. */
export function put(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function nodeValue(node: Node): unknown {
  if (node.type === "object") {
    const out = {};
    for (const prop of node.children ?? []) {
      const [key, value] = prop.children ?? [];
      if (key !== undefined && value !== undefined) put(out, String(key.value), nodeValue(value));
    }
    return out;
  }
  if (node.type === "array") return (node.children ?? []).map(nodeValue);
  return node.value;
}

export function parseSettingsText(text: string, file: string): Parsed {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length > 0) {
    throw new SettingsError(
      errors.map((e) => ({
        file,
        line: lineOf(text, e.offset),
        key: "",
        message: `invalid JSON: ${printParseErrorCode(e.error)}`,
      })),
    );
  }
  return { value: tree === undefined ? {} : nodeValue(tree), tree };
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** The line of the deepest part of `path` that exists in the file. */
export function locate(text: string | undefined, tree: Node | undefined, path: Segment[]): number | undefined {
  if (text === undefined || tree === undefined) return undefined;
  for (let n = path.length; n >= 0; n--) {
    const node = findNodeAtLocation(tree, path.slice(0, n));
    if (node !== undefined) return lineOf(text, node.offset);
  }
  return undefined;
}

export function formatKey(path: readonly Segment[]): string {
  return path.reduce<string>(
    (acc, seg) => (typeof seg === "number" ? `${acc}[${seg}]` : acc === "" ? seg : `${acc}.${seg}`),
    "",
  );
}
