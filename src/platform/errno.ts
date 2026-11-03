export function isErrno(e: unknown, ...codes: string[]): boolean {
  return e instanceof Error && "code" in e && typeof e.code === "string" && codes.includes(e.code);
}

/** Any error carrying a string `code`: an errno (ENAMETOOLONG, ELOOP, EACCES, EIO, ...) or a Node `ERR_*` argument error. */
export function isFsError(e: unknown): e is Error & { code: string } {
  return e instanceof Error && "code" in e && typeof e.code === "string";
}

/** The pattern matchers are quadratic in a path's components (and the `ignore` library recurses once per component, which
 * overflows the stack near 20,000), and no real tree is this deep (F92). */
export const MAX_PATH_COMPONENTS = 256;

export const tooDeep = (path: string): boolean => path.split(/[\\/]/).length > MAX_PATH_COMPONENTS;
