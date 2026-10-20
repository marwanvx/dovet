// Images read in the headless boot (tools §1.6): logged as media, rendered into the next request, budgeted.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fakePlatform, scriptedModel, sequentialIds, tempProject, testPng } from "../../test/helpers/index.ts";
import { createSdkAdapter } from "../ai/index.ts";
import type { Os } from "../platform/index.ts";
import type { EventEnvelope } from "../schema/index.ts";
import { createBlobStore, type LoadedSettings, type LoadInput, readSession } from "../store/index.ts";

import { runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
const readPng = { toolCall: { id: "c1", name: "Read", input: { file_path: "shot.png" } } };

async function run(dir: { root: string }, steps: Parameters<typeof scriptedModel>[0]) {
  const env = { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" };
  const settings = {
    settings: { provider: "nvidia", model: "test/model" },
    rules: { allow: [], ask: [], deny: [] },
    warnings: [],
    notices: [],
    files: [],
    untrusted: [],
  } as unknown as LoadedSettings;
  const loadInput: LoadInput = {
    dirs: { config: join(dir.root, "cfg") },
    home: join(dir.root, "home"),
    projectRoot: dir.root,
    env,
    trust: { project: true, local: true },
  };
  const model = scriptedModel(steps);
  const data = join(dir.root, "data");
  const blobs = createBlobStore(data);
  const out = await runHeadless({
    dirs: { config: join(dir.root, "cfg"), data, cache: join(dir.root, "cache") },
    projectRoot: dir.root,
    cwd: dir.root,
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
      allowedTools: [],
      disallowedTools: [],
    },
    prompt: "look at the screenshot",
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
  const log = await readSession({ data, projectRoot: dir.root, os: testOs(), session: out.sessionId });
  return { out, model, events: log.events };
}

type ResultData = { status: string; output: string; media?: Array<{ kind: string; mediaType: string; bytes: number }> };
const resultsOf = (events: readonly EventEnvelope[]): ResultData[] =>
  events.filter((e) => e.type === "tool.result").map((e) => e.data as ResultData);

const withModels = (models: object) => ({ ".dovet/settings.json": JSON.stringify({ models }) });
const vision = withModels({ "test/model": { capabilities: { images: true } } });

describe("Read of an image in the headless boot", () => {
  // spec: AC-TOOLS-20
  test("the picture is logged as media and the next request carries it as an image part", async () => {
    const dir = await tempProject(vision);
    try {
      await Bun.write(join(dir.root, "shot.png"), testPng(300, 200));
      const { out, model, events } = await run(dir, [readPng, { text: "a gradient" }]);
      expect(out.exit).toEqual({ kind: "ok" });
      const media = resultsOf(events)[0]?.media;
      expect(media).toHaveLength(1);
      expect(media?.[0]).toMatchObject({ kind: "image", mediaType: "image/png" });
      expect(media?.[0]?.bytes).toBeGreaterThan(100);

      const second = JSON.stringify(model.doStreamCalls[1]?.prompt);
      expect(second).toContain('"type":"file"');
      expect(second).toContain('"mediaType":"image/png"');
      expect(second).toContain("Images returned by the tool calls above");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TOOLS-35
  test("a model that is not known to take images is told so, and nothing is logged as media", async () => {
    const dir = await tempProject({});
    try {
      await Bun.write(join(dir.root, "shot.png"), testPng(300, 200));
      const { events } = await run(dir, [readPng, { text: "cannot" }]);
      const [only] = resultsOf(events);
      expect(only?.output).toBe("The current model can't view images.");
      expect(only?.media).toBeUndefined();
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TOOLS-35
  test("maxImages from the model override stops the next picture with the /compact hint", async () => {
    const dir = await tempProject(
      withModels({ "test/model": { capabilities: { images: true }, quirks: { maxImages: 1 } } }),
    );
    try {
      await Bun.write(join(dir.root, "shot.png"), testPng(300, 200));
      const second = { toolCall: { id: "c2", name: "Read", input: { file_path: "shot.png" } } };
      const { events } = await run(dir, [readPng, second, { text: "done" }]);
      const results = resultsOf(events);
      expect(results[0]?.status).toBe("ok");
      expect(results[1]?.status).toBe("error");
      expect(results[1]?.output).toContain("Too many images in this conversation (1). Run /compact");
    } finally {
      await dir.dispose();
    }
  });
});
