import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "./remove-dir.ts";

const busy = (code: string): Error => Object.assign(new Error(`${code}: resource busy or locked`), { code });

describe("removeDir", () => {
  test("removes a real directory tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-removedir-"));
    await writeFile(join(dir, "a.txt"), "x");
    await removeDir(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  test("retries while Windows still holds a file (EBUSY, EPERM, ENOTEMPTY) and then succeeds", async () => {
    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY"]) {
      let calls = 0;
      await removeDir("x", {
        remove: async () => {
          calls++;
          if (calls < 4) throw busy(code);
        },
        delayMs: 1,
      });
      expect(calls).toBe(4);
    }
  });

  test("gives up after the attempts and throws the last error", async () => {
    let calls = 0;
    const failing = removeDir("x", {
      remove: async () => {
        calls++;
        throw busy("EBUSY");
      },
      attempts: 3,
      delayMs: 1,
    });
    await expect(failing).rejects.toThrow("EBUSY");
    expect(calls).toBe(3);
  });

  test("does not retry an error that waiting cannot fix", async () => {
    let calls = 0;
    const failing = removeDir("x", {
      remove: async () => {
        calls++;
        throw busy("EACCES");
      },
      delayMs: 1,
    });
    await expect(failing).rejects.toThrow("EACCES");
    expect(calls).toBe(1);
  });
});
