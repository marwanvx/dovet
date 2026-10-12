// The composition root's product: process-wide state owned by one Runtime (interfaces §9, architecture "State ownership").
import type { Platform } from "../platform/index.ts";
import type { AbsPath, Ulid } from "../schema/index.ts";

export interface RuntimeDeps {
  clock: { now(): number };
  ids: { ulid(): Ulid };
  platform: Platform;
  dirs: { config: AbsPath; data: AbsPath; cache: AbsPath };
  env: Readonly<Record<string, string>>;
  baseUrls?: Partial<Record<string, string>>;
  stdio: { isTTY: boolean };
}

export interface Runtime {
  readonly deps: Readonly<RuntimeDeps>;
  readonly closed: boolean;
  close(): Promise<void>;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const owned: RuntimeDeps = {
    ...deps,
    dirs: Object.freeze({ ...deps.dirs }),
    env: Object.freeze({ ...deps.env }),
    stdio: Object.freeze({ ...deps.stdio }),
  };
  let closed = false;
  return {
    deps: Object.freeze(owned),
    get closed() {
      return closed;
    },
    close() {
      closed = true;
      return Promise.resolve();
    },
  };
}
