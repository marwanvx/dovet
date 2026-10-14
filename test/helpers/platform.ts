import { isAbsolute, join } from "node:path";
import type { Platform } from "../../src/platform/index.ts";

/** A Platform that does nothing real: paths are joined, spawning is an error, nothing is on the clipboard. */
export function fakePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    os: "linux",
    arch: "x64",
    canonicalize: (p, cwd) => (isAbsolute(p) ? p : join(cwd, p)),
    spawn: () => {
      throw new Error("fakePlatform: spawn is not scripted");
    },
    killTree: () => Promise.resolve(),
    sweep: () => Promise.resolve([]),
    shells: () => ({}),
    clipboard: { readImage: () => Promise.resolve(null), writeText: () => Promise.resolve() },
    libexec: (name) => `/libexec/${name}`,
    resolve: () => Promise.resolve(undefined),
    resolveShell: () => Promise.resolve(undefined),
    ...overrides,
  };
}
