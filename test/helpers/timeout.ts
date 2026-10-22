import { setDefaultTimeout } from "bun:test";

/** One windows-latest run stalled for about 20 s, so tests that take 0.1 s elsewhere took over 5 s each (F24); 30 s is what the slow tests already use. */
export function defaultTestTimeoutMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 30_000 : 5_000;
}

setDefaultTimeout(defaultTestTimeoutMs(process.platform));
