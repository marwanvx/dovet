// End-of-line choice for a new file (tools §2 step 6): .editorconfig, then .gitattributes, then neighbouring files, else LF.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { isErrno } from "../platform/index.ts";

type Eol = "\n" | "\r\n";
const NEIGHBOURS = 5;
const MAX_NEIGHBOUR_BYTES = 1024 * 1024;

function globToRegExp(glob: string, anchored: boolean): RegExp {
  let out = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      const double = glob[i + 1] === "*";
      out += double ? ".*" : "[^/]*";
      if (double) i++;
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      out += "(?:";
      depth++;
    } else if (c === "}" && depth > 0) {
      out += ")";
      depth--;
    } else if (c === "," && depth > 0) out += "|";
    else out += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${out}$`);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if (isErrno(e, "ENOENT", "ENOTDIR", "EISDIR", "EACCES")) return undefined;
    throw e;
  }
}

const asEol = (v: string | undefined): Eol | undefined => (v === "lf" ? "\n" : v === "crlf" ? "\r\n" : undefined);

function editorconfigEol(config: string, relPath: string): { eol: Eol | undefined; root: boolean } {
  let root = false;
  let matches = false;
  let eol: Eol | undefined;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section !== null) {
      const pattern = section[1] ?? "";
      matches = globToRegExp(pattern.replace(/^\//, ""), pattern.includes("/")).test(relPath);
      continue;
    }
    const pair = /^([\w-]+)\s*[=:]\s*(\S+)/.exec(line);
    if (pair === null) continue;
    const [, key, value] = pair;
    if (key?.toLowerCase() === "root" && !matches) root = value?.toLowerCase() === "true";
    else if (matches && key?.toLowerCase() === "end_of_line") eol = asEol(value?.toLowerCase()) ?? eol;
  }
  return { eol, root };
}

function gitattributesEol(content: string, relPath: string): Eol | undefined {
  let eol: Eol | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const [pattern, ...attrs] = raw.trim().split(/\s+/);
    if (pattern === undefined || pattern.startsWith("#") || attrs.length === 0) continue;
    if (!globToRegExp(pattern.replace(/^\//, ""), pattern.includes("/")).test(relPath)) continue;
    for (const a of attrs) eol = asEol(/^eol=(\w+)$/.exec(a)?.[1]) ?? eol;
  }
  return eol;
}

async function neighbourEol(dir: string): Promise<Eol | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (e) {
    if (isErrno(e, "ENOENT", "ENOTDIR", "EACCES")) return undefined;
    throw e;
  }
  let crlf = 0;
  let lf = 0;
  let used = 0;
  for (const name of names) {
    if (used === NEIGHBOURS) break;
    const path = join(dir, name);
    const st = await stat(path).catch(() => undefined);
    if (!st?.isFile() || st.size > MAX_NEIGHBOUR_BYTES) continue;
    const body = await readFile(path).catch(() => undefined);
    if (body === undefined || body.includes(0)) continue;
    used++;
    const total = body.toString("latin1").split("\n").length - 1;
    const windows = body.toString("latin1").split("\r\n").length - 1;
    crlf += windows;
    lf += total - windows;
  }
  return crlf > lf ? "\r\n" : undefined;
}

export async function newFileEol(path: string): Promise<Eol> {
  const dirs: string[] = [];
  for (let d = dirname(path); !dirs.includes(d); d = dirname(d)) dirs.push(d);
  let editorconfig: Eol | undefined;
  let attributes: Eol | undefined;
  let editorDone = false;
  let attributesDone = false;
  for (const dir of dirs) {
    const rel = relative(dir, path).split("\\").join("/");
    if (!editorDone) {
      const config = await readOptional(join(dir, ".editorconfig"));
      if (config !== undefined) {
        const found = editorconfigEol(config, rel);
        editorconfig = found.eol;
        editorDone = found.eol !== undefined || found.root;
      }
    }
    if (!attributesDone) {
      const attrs = await readOptional(join(dir, ".gitattributes"));
      if (attrs !== undefined) {
        attributes = gitattributesEol(attrs, rel);
        attributesDone = attributes !== undefined;
      }
    }
    const repoRoot = await stat(join(dir, ".git")).then(
      () => true,
      () => false,
    );
    if (repoRoot) break;
    if ((editorDone || basename(dir) === "") && attributesDone) break;
  }
  return editorconfig ?? attributes ?? (await neighbourEol(dirname(path))) ?? "\n";
}
