import { afterEach, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TempProject, tempProject } from "../../../test/helpers/index.ts";
import { createBlobStore } from "./index.ts";

let dir: TempProject | undefined;
afterEach(async () => {
  await dir?.dispose();
});

test("stores bytes under their SHA-256, once, and reads them back", async () => {
  dir = await tempProject();
  const blobs = createBlobStore(join(dir.root, "data"));
  const bytes = new TextEncoder().encode("hello");
  const sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  expect(blobs.putSync(bytes)).toBe(sha);
  expect(blobs.putSync(bytes)).toBe(sha);
  expect(await readdir(join(dir.root, "data", "blobs", "2c"))).toEqual([sha]);
  expect(new TextDecoder().decode(await blobs.get(sha))).toBe("hello");
  expect(await blobs.get("0".repeat(64))).toBeUndefined();
});

test("a blob whose bytes no longer match its name is reported, not returned", async () => {
  dir = await tempProject();
  const blobs = createBlobStore(join(dir.root, "data"));
  const sha = blobs.putSync(new TextEncoder().encode("hello"));
  await writeFile(join(dir.root, "data", "blobs", sha.slice(0, 2), sha), "tampered");
  await expect(blobs.get(sha)).rejects.toThrow(`blob ${sha} is damaged`);
});
