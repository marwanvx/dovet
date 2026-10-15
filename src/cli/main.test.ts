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

describe("dovet -p headless", () => {
  async function headless(
    args: string[],
    opts: { stdin?: string; env?: Record<string, string>; files?: Record<string, string> } = {},
  ) {
    const dir = await tempProject(opts.files ?? {});
    try {
      const r = Bun.spawnSync([process.execPath, MAIN, ...args], {
        cwd: dir.root,
        stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : undefined,
        env: {
          ...process.env,
          DOVET_CONFIG_DIR: join(dir.root, "config"),
          DOVET_DATA_DIR: join(dir.root, "data"),
          NVIDIA_API_KEY: "nvapi-FAKE-HEADLESS-KEY",
          ...opts.env,
        },
      });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), dir };
    } catch (e) {
      await dir.dispose();
      throw e;
    }
  }

  // spec: AC-CLI-09
  test("piped stdin is attached before the prompt", async () => {
    const { dir, ...r } = await headless(["-p", "why?", "--output", "text"], { stdin: "log lines" });
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain("log lines");
      expect(r.out.indexOf("log lines")).toBeLessThan(r.out.indexOf("why?"));
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-09
  test("no prompt argument reads the prompt from stdin", async () => {
    const { dir, ...r } = await headless(["-p"], { stdin: "do it" });
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain("do it");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TUI-05
  test("json output validates against the published schema", async () => {
    const { HeadlessJson } = await import("./headless-output.ts");
    const { dir, ...r } = await headless(["-p", "hi", "--output", "json"]);
    try {
      expect(r.code).toBe(0);
      expect(HeadlessJson.safeParse(JSON.parse(r.out)).success).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TUI-05
  test("unknown output format exits 2", async () => {
    const { dir, ...r } = await headless(["-p", "hi", "--output", "yaml"]);
    try {
      expect(r.code).toBe(2);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-13
  test("inherited DOVET_RUN does not change behavior", async () => {
    const { dir, ...r } = await headless(["-p", "hi"], { env: { DOVET_RUN: "parent-marker" } });
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain("hi");
      expect(r.err).toContain("DOVET_RUN");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-13
  test("a corrupt trusted-folders.json is backed up and the run succeeds", async () => {
    const { dir, ...r } = await headless(["-p", "hi"], { files: { "data/trusted-folders.json": "{ not json" } });
    try {
      expect(r.code).toBe(0);
      expect(r.err).toContain("backed up");
      const { readdirSync, readFileSync } = await import("node:fs");
      const names = readdirSync(join(dir.root, "data"));
      const backup = names.find((n) => n.startsWith("trusted-folders.json.corrupt-"));
      expect(backup).toBeDefined();
      expect(JSON.parse(readFileSync(join(dir.root, "data", "trusted-folders.json"), "utf8"))).toEqual({});
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-13
  test("an unwritable data dir still starts with a no-save notice", async () => {
    const dir = await tempProject({ datafile: "x" });
    try {
      const r = Bun.spawnSync([process.execPath, MAIN, "-p", "hi"], {
        cwd: dir.root,
        env: {
          ...process.env,
          DOVET_CONFIG_DIR: join(dir.root, "config"),
          DOVET_DATA_DIR: join(dir.root, "datafile"),
          NVIDIA_API_KEY: "nvapi-FAKE-HEADLESS-KEY",
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toString()).toContain("won't be saved");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-13
  test("startup makes no network requests", async () => {
    let hits = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits += 1;
        return new Response("blocked", { status: 502 });
      },
    });
    const dir = await tempProject({});
    try {
      await fetch(`http://127.0.0.1:${proxy.port}/`).catch(() => undefined);
      expect(hits).toBeGreaterThan(0);
      hits = 0;
      const start = Date.now();
      const proc = Bun.spawn([process.execPath, MAIN, "-p", "hi"], {
        cwd: dir.root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          DOVET_CONFIG_DIR: join(dir.root, "config"),
          DOVET_DATA_DIR: join(dir.root, "data"),
          NVIDIA_API_KEY: "nvapi-FAKE-HEADLESS-KEY",
          http_proxy: `http://127.0.0.1:${proxy.port}`,
          https_proxy: `http://127.0.0.1:${proxy.port}`,
          HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
          HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
          no_proxy: "",
          NO_PROXY: "",
        },
      });
      const [out, stderrText, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(out).toContain("hi");
      expect(stderrText).not.toContain("dovet: no provider");
      expect(hits).toBe(0);
      expect(Date.now() - start).toBeLessThan(10_000);
    } finally {
      proxy.stop(true);
      await dir.dispose();
    }
  });

  // spec: AC-CLI-19
  test("--offline runs without network and still outputs", async () => {
    const { dir, ...r } = await headless(["-p", "hi", "--offline"]);
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain("hi");
      expect(r.err).toContain("offline mode");
    } finally {
      await dir.dispose();
    }
  });
});
