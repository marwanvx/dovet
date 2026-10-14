// The Platform seam (interfaces §2b): everything OS-specific that the rest of Dovet may call, fakeable in tests.
import type { AbsPath } from "../schema/index.ts";

export type ChildHandle = {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
};

export type Os = "linux" | "darwin" | "win32";

export interface Platform {
  os: Os;
  arch: string;
  canonicalize(p: string, cwd: AbsPath): AbsPath;
  spawn(cmd: {
    argv: string[];
    cwd: AbsPath;
    env: Record<string, string>;
    stdin?: "null" | string;
    signal: AbortSignal;
    group: string;
  }): ChildHandle;
  killTree(group: string): Promise<void>;
  /** Stops what a finished command left running (its process group and DOVET_RUN-marked escapees) and names it. */
  sweep(group: string, marker: string): Promise<Array<{ pid: number; name: string }>>;
  shells(): { bash?: AbsPath; powershell?: AbsPath; gitBash?: AbsPath };
  clipboard: { readImage(): Promise<Uint8Array | null>; writeText(t: string): Promise<void> };
  libexec(name: "rg" | "srt"): AbsPath;
  // ASSUMPTION (QUESTIONS Q18): not yet in interfaces §2b
  resolve(program: string): Promise<AbsPath | undefined>;
}
