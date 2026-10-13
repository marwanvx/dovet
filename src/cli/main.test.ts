import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json";
import { tempProject } from "../../test/helpers/index.ts";

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

describe("dovet auth status", () => {
  const KEY = "nvapi-FAKE-USED-VALUE";
  const OTHER = "nvapi-FAKE-SHADOWED-VALUE";

  // spec: AC-CLI-17
  test("shows which source each provider's key comes from and which are shadowed, without the keys", async () => {
    const dir = await tempProject({
      "config/settings.json": '{ "providers": { "nvidia": { "apiKey": "env:WORK_KEY" } } }',
    });
    try {
      const r = Bun.spawnSync([process.execPath, MAIN, "auth", "status"], {
        cwd: dir.root,
        env: {
          ...process.env,
          DOVET_CONFIG_DIR: join(dir.root, "config"),
          DOVET_DATA_DIR: join(dir.root, "data"),
          WORK_KEY: KEY,
          NVIDIA_API_KEY: OTHER,
        },
      });
      const out = r.stdout.toString() + r.stderr.toString();
      expect(r.exitCode).toBe(0);
      expect(out).toContain("nvidia\n  used: env:WORK_KEY (settings)\n");
      expect(out).toContain("  shadowed: environment variable NVIDIA_API_KEY\n");
      expect(out).not.toContain(KEY);
      expect(out).not.toContain(OTHER);
    } finally {
      await dir.dispose();
    }
  });

  function status(files: Record<string, string>, env: Record<string, string>) {
    return tempProject(files).then(async (dir) => {
      try {
        const r = Bun.spawnSync([process.execPath, MAIN, "auth", "status"], {
          cwd: dir.root,
          env: {
            ...process.env,
            DOVET_CONFIG_DIR: join(dir.root, "config"),
            DOVET_DATA_DIR: join(dir.root, "data"),
            ...env,
          },
        });
        return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
      } finally {
        await dir.dispose();
      }
    });
  }

  test("a settings reference to an unset env var is shown as broken", async () => {
    const r = await status(
      { "config/settings.json": '{ "providers": { "nvidia": { "apiKey": "env:WORK_KEY" } } }' },
      {
        WORK_KEY: "",
      },
    );
    expect(r.out).toContain("nvidia\n  used: env:WORK_KEY (settings), but WORK_KEY is not set\n");
  });
});
