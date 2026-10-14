// Per-session map of what the model has seen of each file (tools §0 "Read-state").
import { type Os, pathKey } from "../platform/index.ts";

export type ReadStateEntry = {
  sha256: string;
  mtimeMs: number;
  size: number;
  partial: boolean;
  encoding: "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "invalid";
  eol: "\n" | "\r\n" | "mixed";
};

export interface ReadStateStore {
  get(path: string): ReadStateEntry | undefined;
  set(path: string, entry: ReadStateEntry): void;
  delete(path: string): void;
}

export function createReadState(os: Os): ReadStateStore {
  const entries = new Map<string, ReadStateEntry>();
  return {
    get: (path) => {
      const e = entries.get(pathKey(path, os));
      return e && { ...e };
    },
    set: (path, entry) => {
      entries.set(pathKey(path, os), { ...entry });
    },
    delete: (path) => {
      entries.delete(pathKey(path, os));
    },
  };
}
