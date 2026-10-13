export function isErrno(e: unknown, ...codes: string[]): boolean {
  return e instanceof Error && "code" in e && typeof e.code === "string" && codes.includes(e.code);
}
