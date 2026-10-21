import { afterEach } from "bun:test";
import { rm } from "node:fs/promises";

const dirs: string[] = [];

export function removeAfterTest(dir: string): void {
  dirs.push(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
