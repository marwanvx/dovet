// The Platform seam (interfaces §2b): everything OS-specific that the rest of Dovet may call, fakeable in tests.
import type { AbsPath } from "../schema/index.ts";

export type ChildHandle = {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
};

export interface Platform {
  os: "linux" | "darwin" | "win32";
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
  shells(): { bash?: AbsPath; powershell?: AbsPath; gitBash?: AbsPath };
  clipboard: { readImage(): Promise<Uint8Array | null>; writeText(t: string): Promise<void> };
  libexec(name: "rg" | "srt"): AbsPath;
}
