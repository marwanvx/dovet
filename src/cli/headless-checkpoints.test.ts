// Checkpoints in the headless boot (docs/specs/checkpoints.md "When"): taken before the turn's first change, logged as `checkpoint`.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fakePlatform, scriptedModel, sequentialIds, tempProject } from "../../test/helpers/index.ts";
import { createSdkAdapter } from "../ai/index.ts";
import type { Os } from "../platform/index.ts";
import { CheckpointData, type EventEnvelope } from "../schema/index.ts";
import { createBlobStore, type LoadedSettings, type LoadInput, readSession } from "../store/index.ts";
import { runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");

const read = { toolCall: { id: "c1", name: "Read", input: { file_path: "a.txt" } } };
const write = { toolCall: { id: "c2", name: "Write", input: { file_path: "a.txt", content: "changed\n" } } };

async function run(root: string, steps: Parameters<typeof scriptedModel>[0]) {
  const env = { NVIDIA_API_KEY: "nvapi-FAKE", HOME: process.env.HOME ?? "/tmp", PATH: process.env.PATH };
  const settings = {
    settings: { provider: "nvidia", model: "test/model" },
    rules: { allow: [], ask: [], deny: [] },
    warnings: [],
    notices: [],
    files: [],
    untrusted: [],
  } as unknown as LoadedSettings;
  const loadInput: LoadInput = {
    dirs: { config: join(root, "cfg") },
    home: join(root, "home"),
    projectRoot: root,
    env,
    trust: { project: true, local: true },
  };
  const model = scriptedModel(steps);
  const data = join(root, "data");
  const blobs = createBlobStore(data);
  const out = await runHeadless({
    dirs: { config: join(root, "cfg"), data, cache: join(root, "cache") },
    projectRoot: root,
    cwd: root,
    os: testOs(),
    settings,
    env,
    loadInput,
    args: {
      print: true,
      output: "text",
      offline: false,
      noSessionPersistence: false,
      continued: false,
      repair: false,
      allowedTools: ["Write"],
      disallowedTools: [],
    },
    prompt: "change it",
    clock: { now: () => Date.UTC(2026, 9, 21) },
    ids: sequentialIds("M"),
    pid: 1,
    host: "h",
    platform: fakePlatform(),
    adapter: createSdkAdapter({
      endpoint: () => ({ package: "@ai-sdk/openai-compatible", baseURL: "http://unused" }),
      model: () => model,
      blobBytes: (sha) => blobs.getSync(sha),
    }),
  });
  const log = await readSession({ data, projectRoot: root, os: testOs(), session: out.sessionId });
  return { out, events: log.events };
}

const checkpointsOf = (events: readonly EventEnvelope[]): CheckpointData[] =>
  events.filter((e) => e.type === "checkpoint").map((e) => CheckpointData.parse(e.data));

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

describe("checkpoints in a headless turn", () => {
  test("a git workspace logs a git-tree checkpoint c1 before the turn's first change", async () => {
    const dir = await tempProject({ "a.txt": "original\n" });
    try {
      git(dir.root, "init", "-q");
      git(dir.root, "add", ".");
      git(dir.root, "commit", "-q", "-m", "init");
      const { out, events } = await run(dir.root, [read, write, { text: "done" }]);
      expect(out.exit).toEqual({ kind: "ok" });
      expect(await readFile(join(dir.root, "a.txt"), "utf8")).toBe("changed\n");
      const [only, ...rest] = checkpointsOf(events);
      expect(rest).toEqual([]);
      expect(only).toMatchObject({ id: "c1", mechanism: "git-tree" });
      const types = events.map((e) => e.type);
      expect(types.indexOf("checkpoint")).toBeGreaterThan(types.indexOf("tool.call"));
      expect(types.indexOf("checkpoint")).toBeLessThan(types.indexOf("file.change"));
      expect(events.find((e) => e.type === "checkpoint")?.turn).toBe(1);
    } finally {
      await dir.dispose();
    }
  });

  test("outside git the checkpoint keeps the file's old bytes in the blob store", async () => {
    const dir = await tempProject({ "a.txt": "original\n" });
    try {
      const { events } = await run(dir.root, [read, write, { text: "done" }]);
      const [only] = checkpointsOf(events);
      expect(only?.mechanism).toBe("blobs");
      const before = only?.mechanism === "blobs" ? only.files[0]?.before : undefined;
      expect(before).toBeDefined();
      const bytes = createBlobStore(join(dir.root, "data")).getSync(before ?? "");
      expect(new TextDecoder().decode(bytes)).toBe("original\n");
    } finally {
      await dir.dispose();
    }
  });

  test("checkpoints.enabled: false keeps blobs even in a git workspace", async () => {
    const dir = await tempProject({
      "a.txt": "original\n",
      ".dovet/settings.json": '{"checkpoints":{"enabled":false}}',
    });
    try {
      git(dir.root, "init", "-q");
      git(dir.root, "add", ".");
      git(dir.root, "commit", "-q", "-m", "init");
      const { events } = await run(dir.root, [read, write, { text: "done" }]);
      expect(checkpointsOf(events).map((c) => c.mechanism)).toEqual(["blobs"]);
    } finally {
      await dir.dispose();
    }
  });

  test("a turn that only reads logs no checkpoint", async () => {
    const dir = await tempProject({ "a.txt": "original\n" });
    try {
      git(dir.root, "init", "-q");
      git(dir.root, "add", ".");
      git(dir.root, "commit", "-q", "-m", "init");
      const { events } = await run(dir.root, [read, { text: "done" }]);
      expect(checkpointsOf(events)).toEqual([]);
    } finally {
      await dir.dispose();
    }
  });
});
