import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { AbsPath } from "../schema/index.ts";
import { isErrno } from "./errno.ts";
import type { Os } from "./types.ts";

export class PathRefused extends Error {}

/** Why Windows would send credentials to, or talk to a device through, this path (platforms "Network and device paths"), else undefined. */
export function windowsRefusal(p: string): string | undefined {
  if (/^[\\/]\?\?[\\/]/.test(p)) return "NT object paths (\\??\\) are refused";
  if (/^[\\/]{2}\.[\\/]?/.test(p)) return "device paths (\\\\.\\) are refused";
  if (/^[\\/]{2}\?[\\/]+[A-Za-z]:[\\/]/.test(p)) return undefined;
  if (/^[\\/]{2}/.test(p)) return "network paths (UNC) are refused: Windows would send your credentials to that server";
  return undefined;
}

/** An absolute path from `p` (relative to `cwd`) without touching the file system. Windows also takes `/c/Users/x` and `C:/Users/x`. */
export function lexicalPath(p: string, cwd: string, os: Os): string {
  if (os !== "win32") {
    if (!posix.isAbsolute(cwd)) throw new PathRefused(`working directory is not absolute: ${cwd}`);
    return posix.resolve(cwd, p);
  }
  for (const candidate of [p, cwd]) {
    const reason = windowsRefusal(candidate);
    if (reason !== undefined) throw new PathRefused(`${candidate}: ${reason}`);
  }
  let input = p.replace(/^[\\/]{2}\?[\\/]+(?=[A-Za-z]:[\\/])/, "");
  const gitBash = /^\/([A-Za-z])(?:\/(.*))?$/.exec(input);
  if (gitBash !== null) input = `${(gitBash[1] ?? "").toUpperCase()}:\\${gitBash[2] ?? ""}`;
  else if (/^\/(?![\\/])/.test(input))
    throw new PathRefused(`${p}: only Git Bash drive paths (/c/...) can be mapped; write a C:\\ path`);
  else if (/^[A-Za-z]:(?![\\/])/.test(input))
    throw new PathRefused(`${p}: drive-relative paths (C:file) are refused; write C:\\file`);
  if (!win32.isAbsolute(cwd)) throw new PathRefused(`working directory is not absolute: ${cwd}`);
  return win32.resolve(cwd, input);
}

/** The real path of `p`: symlinks, macOS `/var` links and Windows short names resolved; a not-yet-existing tail is kept as written. */
export function canonicalizePath(
  p: string,
  cwd: string,
  os: Os,
  realpath: (p: string) => string = realpathSync.native,
): AbsPath {
  const impl = os === "win32" ? win32 : posix;
  const lexical = lexicalPath(p, cwd, os);
  let head = lexical;
  const tail: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = realpath(head);
      break;
    } catch (e) {
      if (!isErrno(e, "ENOENT", "ENOTDIR")) throw e;
      const parent = impl.dirname(head);
      if (parent === head) {
        real = head;
        break;
      }
      tail.unshift(impl.basename(head));
      head = parent;
    }
  }
  const result = impl.join(real, ...tail);
  if (os !== "win32" || windowsRefusal(result) === undefined) return result;
  // A mapped network drive resolves to its UNC target and its drive letter is allowed; a link inside a local drive that
  // points at a share is not (Windows would send the user's credentials to it).
  const driveRoot = win32.parse(lexical).root;
  const rootReal = realpath(driveRoot);
  if (windowsRefusal(rootReal) === undefined || !isWithin(result, rootReal, os)) {
    throw new PathRefused(`${p}: resolves to ${result}; ${windowsRefusal(result)}`);
  }
  return win32.join(driveRoot, win32.relative(rootReal, result));
}

/** Key for comparing paths: macOS and Windows are treated as case-insensitive, Linux is not (SPIKE-10). */
export function pathKey(p: string, os: Os): string {
  const sep = os === "win32" ? "\\" : "/";
  let key = os === "win32" ? p.replaceAll("/", "\\").replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "") : p;
  if (os !== "linux") key = key.toLowerCase();
  while (key.length > 1 && key.endsWith(sep) && !/^[a-z]:\\$/.test(key)) key = key.slice(0, -1);
  return key;
}

export function isWithin(child: string, root: string, os: Os): boolean {
  const c = pathKey(child, os);
  const r = pathKey(root, os);
  const sep = os === "win32" ? "\\" : "/";
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}
