import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { streamText } from "ai";
import { Ulid } from "../../src/schema/index.ts";
import { fakeClock, scriptedModel, sequentialIds, tempProject } from "./index.ts";

describe("fakeClock", () => {
  test("only moves when told to", () => {
    const clock = fakeClock(10);
    expect(clock.now()).toBe(10);
    expect(clock.now()).toBe(10);
    clock.advance(5);
    expect(clock.now()).toBe(15);
  });
});

describe("sequentialIds", () => {
  test("are valid, unique and increasing ULIDs", () => {
    const ids = sequentialIds();
    const drawn = Array.from({ length: 50 }, () => ids.ulid());
    for (const id of drawn) expect(Ulid.safeParse(id).success).toBe(true);
    expect(new Set(drawn).size).toBe(50);
    expect([...drawn].sort()).toEqual(drawn);
  });

  test("two generators with different seeds never collide", () => {
    const a = sequentialIds("A");
    const b = sequentialIds("B");
    expect(a.ulid()).not.toBe(b.ulid());
  });
});

describe("tempProject", () => {
  test("creates the files, resolves symlinks in its root, and removes everything on dispose", async () => {
    const project = await tempProject({ "src/a.ts": "export const a = 1;\n", "README.md": "hi" });
    const root = project.root;
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    await project.dispose();
    expect(existsSync(root)).toBe(false);
  });

  test("two projects get different roots", async () => {
    const a = await tempProject({});
    const b = await tempProject({});
    expect(a.root).not.toBe(b.root);
    await a.dispose();
    await b.dispose();
  });
});

describe("scriptedModel", () => {
  test("replays the scripted steps in order through the real AI SDK", async () => {
    const model = scriptedModel([
      { text: "first" },
      { toolCall: { id: "call_1", name: "Read", input: { file_path: "/a" } } },
    ]);
    const one = streamText({ model, prompt: "go", maxRetries: 0 });
    expect(await one.text).toBe("first");
    expect(await one.finishReason).toBe("stop");

    const two = streamText({ model, prompt: "again", maxRetries: 0 });
    const calls = await two.toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("Read");
    expect(await two.finishReason).toBe("tool-calls");
    expect(model.doStreamCalls).toHaveLength(2);
  });

  test("fails loudly when the script runs out", async () => {
    const model = scriptedModel([{ text: "only" }]);
    await streamText({ model, prompt: "1", maxRetries: 0 }).text;
    const errors: unknown[] = [];
    const second = streamText({ model, prompt: "2", maxRetries: 0, onError: ({ error }) => errors.push(error) });
    await Promise.resolve(second.text).catch(() => undefined);
    expect(String(errors[0])).toMatch(/script exhausted/);
  });
});
