import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json";
import { sseBody, startFixtureServer, tempProject } from "../../test/helpers/index.ts";
import type { Os } from "../platform/index.ts";
import { listSessions, readSession } from "../store/index.ts";

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
  const ANSWER = "fixture answer";
  const servers: Array<{ stop(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  const testOs = (): Os =>
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";

  function textExchange() {
    const delta = (d: unknown, finish: string | null = null) => ({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "test/model",
      choices: [{ index: 0, delta: d, finish_reason: finish }],
    });
    return {
      request: { path: "", body: "" },
      response: {
        status: 200,
        contentType: "text/event-stream",
        body: sseBody([delta({ content: ANSWER }), delta({}, "stop")]),
      },
    };
  }

  async function headless(
    args: string[],
    opts: { stdin?: string; env?: Record<string, string>; files?: Record<string, string>; dataDir?: string } = {},
  ) {
    const server = startFixtureServer([textExchange()]);
    servers.push(server);
    const dir = await tempProject({
      "config/settings.json": JSON.stringify({
        provider: "nvidia",
        model: "test/model",
        providers: { nvidia: { baseUrl: server.baseURL } },
      }),
      ...opts.files,
    });
    try {
      const dataDir = opts.dataDir === undefined ? join(dir.root, "data") : join(dir.root, opts.dataDir);
      const proc = Bun.spawn([process.execPath, MAIN, ...args], {
        cwd: dir.root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          DOVET_CONFIG_DIR: join(dir.root, "config"),
          DOVET_DATA_DIR: dataDir,
          NVIDIA_API_KEY: "nvapi-FAKE-HEADLESS-KEY",
          ...opts.env,
        },
      });
      const sink = proc.stdin;
      if (opts.stdin !== undefined) sink.write(opts.stdin);
      sink.end();
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, out, err, dir };
    } catch (e) {
      await dir.dispose();
      throw e;
    }
  }

  async function userText(dir: { root: string }): Promise<string> {
    const os = testOs();
    const sessions = await listSessions({ data: join(dir.root, "data"), projectRoot: dir.root, os });
    const last = sessions[sessions.length - 1];
    if (last === undefined) throw new Error("no session was saved");
    const read = await readSession({ data: join(dir.root, "data"), projectRoot: dir.root, os, session: last.id });
    const msg = read.events.find((e) => e.type === "user.message");
    if (msg === undefined) throw new Error("no user.message event");
    return (msg.data as { text: string }).text;
  }

  // spec: AC-CLI-09
  test("piped stdin is attached before the prompt", async () => {
    const { dir, ...r } = await headless(["-p", "why?", "--output", "text"], { stdin: "log lines" });
    try {
      expect(r.code).toBe(0);
      expect(r.out).toBe(`${ANSWER}\n`);
      const text = await userText(dir);
      expect(text).toContain("log lines");
      expect(text.indexOf("log lines")).toBeLessThan(text.indexOf("why?"));
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-09
  test("no prompt argument reads the prompt from stdin", async () => {
    const { dir, ...r } = await headless(["-p"], { stdin: "do it" });
    try {
      expect(r.code).toBe(0);
      expect(r.out).toBe(`${ANSWER}\n`);
      expect(await userText(dir)).toContain("do it");
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
      const parsed = HeadlessJson.safeParse(JSON.parse(r.out));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.result).toBe(ANSWER);
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

  // spec: AC-TUI-05
  test("a recorded NVIDIA tool session drives the real tools end to end", async () => {
    const fx = (await Bun.file(
      join(import.meta.dir, "..", "..", "test", "fixtures", "nvidia", "session.json"),
    ).json()) as {
      exchanges: {
        request: { path: string; body: string };
        response: { status: number; contentType: string; body: string };
      }[];
    };
    const server = startFixtureServer(fx.exchanges.slice(0, 2));
    servers.push(server);
    const dir = await tempProject({
      "config/settings.json": JSON.stringify({
        provider: "nvidia",
        model: "test/model",
        providers: { nvidia: { baseUrl: server.baseURL } },
      }),
      "README.md": "# demo-app\nA small demo.\n",
    });
    try {
      const proc = Bun.spawn([process.execPath, MAIN, "-p", "read the docs"], {
        cwd: dir.root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          DOVET_CONFIG_DIR: join(dir.root, "config"),
          DOVET_DATA_DIR: join(dir.root, "data"),
          NVIDIA_API_KEY: "nvapi-FAKE-HEADLESS-KEY",
        },
      });
      proc.stdin.end();
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ code, err }).toMatchObject({ code: 0 });
      expect(out).toContain("demo-app");
      const os = testOs();
      const sessions = await listSessions({ data: join(dir.root, "data"), projectRoot: dir.root, os });
      const last = sessions[sessions.length - 1];
      if (last === undefined) throw new Error("no session was saved");
      const read = await readSession({ data: join(dir.root, "data"), projectRoot: dir.root, os, session: last.id });
      const calls = read.events.filter((e) => e.type === "tool.call");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const results = read.events.filter((e) => e.type === "tool.result");
      const byCall = new Map(
        results.map((e) => [(e.data as { callId: string }).callId, e.data as { status: string; output: string }]),
      );
      const readmeCall = calls.find(
        (e) =>
          (e.data as { raw: unknown }).raw !== undefined &&
          JSON.stringify((e.data as { raw: unknown }).raw).includes("README.md"),
      );
      if (readmeCall === undefined) throw new Error("no recorded README read ran");
      const readmeResult = byCall.get((readmeCall.data as { callId: string }).callId);
      if (readmeResult === undefined) throw new Error("no result for the README read");
      expect(readmeResult.status).toBe("ok");
      expect(readmeResult.output).toContain("# demo-app");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-13
  test("inherited DOVET_RUN does not change behavior", async () => {
    const { dir, ...r } = await headless(["-p", "hi"], { env: { DOVET_RUN: "parent-marker" } });
    try {
      expect(r.code).toBe(0);
      expect(r.out).toBe(`${ANSWER}\n`);
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
      expect(r.out).toBe(`${ANSWER}\n`);
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
    const { dir, ...r } = await headless(["-p", "hi"], { files: { datafile: "x" }, dataDir: "datafile" });
    try {
      expect(r.code).toBe(0);
      expect(r.out).toBe(`${ANSWER}\n`);
      expect(r.err).toContain("won't be saved");
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
    const fixture = startFixtureServer([textExchange()]);
    servers.push(fixture);
    const dir = await tempProject({
      "config/settings.json": JSON.stringify({
        provider: "nvidia",
        model: "test/model",
        providers: { nvidia: { baseUrl: fixture.baseURL } },
      }),
    });
    try {
      await fetch(`http://127.0.0.1:${(proxy as unknown as { port: number }).port}/`).catch(() => undefined);
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
          http_proxy: `http://127.0.0.1:${(proxy as unknown as { port: number }).port}`,
          https_proxy: `http://127.0.0.1:${(proxy as unknown as { port: number }).port}`,
          HTTP_PROXY: `http://127.0.0.1:${(proxy as unknown as { port: number }).port}`,
          HTTPS_PROXY: `http://127.0.0.1:${(proxy as unknown as { port: number }).port}`,
          no_proxy: "127.0.0.1,localhost",
          NO_PROXY: "127.0.0.1,localhost",
        },
      });
      const [out, stderrText, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(out).toBe(`${ANSWER}\n`);
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
      expect(r.out).toBe(`${ANSWER}\n`);
      expect(r.err).toContain("offline mode");
    } finally {
      await dir.dispose();
    }
  });
});
