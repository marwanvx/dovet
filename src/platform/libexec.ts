import { dirname, join } from "node:path";

/** Helpers that ship beside the executable in the install directory (architecture "Distribution"). */
export type LibexecName = "rg" | "srt";

/**
 * Where a bundled helper lives: `libexec/` next to the running executable. `execPath` must be the real path of the
 * executable (symlinks resolved), because the `dovet` on PATH is a launcher that points into a versioned directory.
 * `srt` is a directory of sandbox-runtime vendor files; `rg` is ripgrep (`rg.exe` on Windows).
 */
export function libexecPath(execPath: string, os: "linux" | "darwin" | "win32", name: LibexecName): string {
  const dir = join(dirname(execPath), "libexec");
  if (name === "srt") return join(dir, "srt");
  return join(dir, os === "win32" ? "rg.exe" : "rg");
}
