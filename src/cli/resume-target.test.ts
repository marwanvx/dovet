import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fakeClock, sequentialIds, type TempProject, tempProject } from "../../test/helpers/index.ts";
import type { Os } from "../platform/index.ts";
import { Ulid } from "../schema/index.ts";
import { openSession, type ProjectLocation } from "../store/index.ts";
import { ephemeralDataDir, makeUlid, resolveResumeTarget } from "./resume-target.ts";

const OS: Os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";

let dir: TempProject | undefined;

async function project(): Promise<{ loc: ProjectLocation; cleanup(): Promise<void> }> {
  dir = await tempProject({ "proj/README.md": "x" });
  const loc: ProjectLocation = { data: join(dir.root, "data"), projectRoot: join(dir.root, "proj"), os: OS };
  return { loc, cleanup: async () => await dir?.dispose() };
}

async function plant(loc: ProjectLocation, session: string): Promise<void> {
  const r = await openSession({
    ...loc,
    session,
    clock: fakeClock(Date.UTC(2026, 9, 13)),
    ids: sequentialIds("A"),
    pid: 1,
    host: "h",
    secrets: [],
    flushMs: 60_000,
  });
  if (r.mode !== "write") throw new Error(r.reason);
  r.writer.append({ type: "user.message", epoch: 0, turn: 1, data: { text: "hi" } });
  await r.writer.close();
}

// Resume target resolution (--resume/--continue) and ephemeral dirs.
describe("resume target", () => {
  test("no sessions is a usage error", async () => {
    const { loc, cleanup } = await project();
    try {
      expect(await resolveResumeTarget(loc, undefined, true)).toEqual({ error: "no saved sessions for this project" });
    } finally {
      await cleanup();
    }
  });

  test("exact, unique prefix, ambiguous and missing ids", async () => {
    const { loc, cleanup } = await project();
    try {
      await plant(loc, "01J0000000000000000000000AA");
      await plant(loc, "01J1000000000000000000000AA");
      expect(await resolveResumeTarget(loc, "01J0000000000000000000000AA", false)).toEqual({
        id: "01J0000000000000000000000AA",
      });
      expect(await resolveResumeTarget(loc, "01J0000000000000000000000", false)).toEqual({
        id: "01J0000000000000000000000AA",
      });
      expect(await resolveResumeTarget(loc, "01J", false)).toEqual({
        error: '"01J" matches 2 sessions; give a longer id',
      });
      expect(await resolveResumeTarget(loc, "01J999", false)).toEqual({ error: 'no session matches "01J999"' });
      expect(await resolveResumeTarget(loc, undefined, true)).toEqual({ id: "01J1000000000000000000000AA" });
    } finally {
      await cleanup();
    }
  });

  test("ephemeral data dirs are real directories", async () => {
    expect((await stat(await ephemeralDataDir())).isDirectory()).toBe(true);
  });

  test("generated ULIDs are valid and ordered", () => {
    const a = makeUlid(1_790_000_000_000, new Uint8Array(16).fill(1));
    const b = makeUlid(1_790_000_000_001, new Uint8Array(16).fill(1));
    expect(Ulid.safeParse(a).success).toBe(true);
    expect(a < b).toBe(true);
  });
});
