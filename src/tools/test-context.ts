import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAfterTest } from "../../test/helpers/workspaces.ts";
import { createPlatformCore, type Os } from "../platform/index.ts";
import { type AbsPath, Settings } from "../schema/index.ts";
import { createReadState, type ReadResultsIndex, type ToolContext, type ToolOutput } from "./index.ts";

export async function workspace(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "dovet-tool-")));
  removeAfterTest(dir);
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
    kill: (pid, signal) => process.kill(pid, signal),
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
    env: {},
    readResults: noHistory,
    contextFreeTokens: 200_000,
    recordWrite: async () => undefined,
    ...over,
  };
}

export const text = (out: ToolOutput): string => out.content.map((p) => (p.kind === "text" ? p.text : "")).join("");

type ReleaseScript = {
  fetchRipgrep(platform: string, cacheDir: string): Promise<Uint8Array>;
  hostTarget(): { ripgrep: string | null };
};

const unpacked = new Map<string, Promise<string>>();

/** A context whose bundled ripgrep is the pinned release for this machine, unpacked once into dist/cache. */
export async function searchContext(cwd: string, over: Partial<ToolContext> = {}, os?: Os): Promise<ToolContext> {
  const ready =
    unpacked.get("rg") ??
    (async () => {
      // By computed path so the dependency check does not see src depending on scripts.
      const release = join(import.meta.dir, "..", "..", "scripts", "build-release.ts");
      const { fetchRipgrep, hostTarget } = (await import(release)) as ReleaseScript;
      const cache = join(import.meta.dir, "..", "..", "dist", "cache");
      const file = join(cache, "rg-test", process.platform === "win32" ? "rg.exe" : "rg");
      if (!(await Bun.file(file).exists())) {
        const bytes = await fetchRipgrep(hostTarget().ripgrep ?? "", join(cache, "ripgrep"));
        await Bun.write(`${file}.tmp`, bytes);
        await chmod(`${file}.tmp`, 0o755);
        await rename(`${file}.tmp`, file);
      }
      return file;
    })();
  unpacked.set("rg", ready);
  const rg = (await ready) as AbsPath;
  const base = context(cwd, over, os);
  return { ...base, env: { ...process.env, HOME: cwd }, platform: { ...base.platform, libexec: () => rg }, ...over };
}
