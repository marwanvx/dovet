import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json";

const MAIN = join(import.meta.dir, "main.ts");

function dovet(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args]);
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("dovet command line", () => {
  test("prints the version", () => {
    expect(dovet()).toMatchObject({ code: 0, out: `dovet ${pkg.version}\n` });
  });

  test("update outside an install says so and exits 1", () => {
    const r = dovet("update");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^dovet: .*install script/);
  });

  test("update --rollback outside an install says so and exits 1", () => {
    const r = dovet("update", "--rollback");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^dovet: .*install script/);
  });

  test("update with an unknown option exits 2 and installs nothing", () => {
    const r = dovet("update", "--rollbak");
    expect(r.code).toBe(2);
    expect(r.err).toBe("usage: dovet update [--rollback]\n");
  });
});
