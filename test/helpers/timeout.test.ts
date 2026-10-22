import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultTestTimeoutMs } from "./timeout.ts";

test("Windows gets six times Bun's 5 s default, other systems keep it", () => {
  expect(defaultTestTimeoutMs("win32")).toBe(30_000);
  expect(defaultTestTimeoutMs("linux")).toBe(5_000);
  expect(defaultTestTimeoutMs("darwin")).toBe(5_000);
});

test("bunfig.toml loads the timeout preload for every test file", () => {
  const bunfig = readFileSync(new URL("../../bunfig.toml", import.meta.url), "utf8");
  expect(bunfig).toContain('"./test/helpers/timeout.ts"');
});
