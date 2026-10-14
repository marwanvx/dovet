import { afterEach } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformCore, type Os } from "../platform/index.ts";
import { type AbsPath, Settings } from "../schema/index.ts";
import { createReadState, type ReadResultsIndex, type ToolContext, type ToolOutput } from "./index.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function workspace(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "dovet-tool-")));
  dirs.push(dir);
  return dir;
}

const noHistory: ReadResultsIndex = { lookup: () => undefined };

export function context(cwd: string, over: Partial<ToolContext> = {}, os: Os = process.platform as Os): ToolContext {
  const core = createPlatformCore({
    os,
    arch: process.arch,
    execPath: process.execPath,
    env: {},
    projectRoot: cwd as AbsPath,
    kill: () => undefined,
  });
  return {
    session: {
      id: "s",
      cwd: cwd as AbsPath,
      workingDirs: [cwd as AbsPath],
      mode: "default",
      taint: [],
      interactive: false,
    },
    settings: Settings.parse({}),
    signal: new AbortController().signal,
    readState: createReadState(os),
    emit: () => undefined,
    platform: {
      ...core,
      shells: () => ({}),
      clipboard: { readImage: async () => null, writeText: async () => undefined },
    },
    readResults: noHistory,
    contextFreeTokens: 200_000,
    recordWrite: async () => undefined,
    ...over,
  };
}

export const text = (out: ToolOutput): string => out.content.map((p) => (p.kind === "text" ? p.text : "")).join("");
