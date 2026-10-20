import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { sseBody, startFixtureServer, startScriptedServer, tempProject } from "../../test/helpers/index.ts";
import { INTERRUPTED_TOOL_TEXT } from "../agent/index.ts";
import type { Os } from "../platform/index.ts";
import {
  CRASH_TOOL_TEXT,
  listSessions,
  projectConfigHash,
  readSession,
  recordTrust,
  resumeSession,
  saveLocalRule,
  sessionPaths,
} from "../store/index.ts";

const MAIN = join(import.meta.dir, "main.ts");

function dovet(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args]);
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function toolCallExchange(call: { id: string; name: string; args: unknown }) {
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
      body: sseBody([
        delta({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }),
        delta({}, "tool_calls"),
      ]),
    },
  };
}

function spawnHeadless(dir: { root: string }, args: string[]) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: dir.root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DOVET_CONFIG_DIR: join(dir.root, "config"),
      DOVET_DATA_DIR: join(dir.root, "data"),
      NVIDIA_API_KEY: "nvapi-FAKE-SIGNAL-KEY",
    },
  });
  proc.stdin.end();
  return proc;
}

function replyExchange() {
  return {
    request: { path: "", body: "" },
    response: {
      status: 200,
      contentType: "text/event-stream",
      body: sseBody([
        {
          id: "c",
          object: "chat.completion.chunk",
          created: 1,
          model: "test/model",
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
        },
      ]),
    },
  };
}

const hostOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");

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

  // spec: permissions §7.6
  test("sandbox status prints platform status and exits 0", () => {
    const r = dovet("sandbox", "status");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`os: ${process.platform}`);
    expect(r.out).toMatch(/sandbox: (on|off|experimental)/);
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
  test("json output on a guard stop emits the JSON reason and exits with the guard code", async () => {
    const { HeadlessJson } = await import("./headless-output.ts");
    const { dir, ...r } = await headless(["-p", "hi", "--output", "json", "--budget", "0"]);
    try {
      expect(r.code).toBe(4);
      const parsed = HeadlessJson.safeParse(JSON.parse(r.out));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.result.toLowerCase()).toContain("budget");
      }
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

  // spec: AC-TUI-05
  test("--budget stops a session with exit code 4 when budget is exceeded", async () => {
    const { dir, ...r } = await headless(["-p", "hi", "--budget", "0"]);
    try {
      expect(r.code).toBe(4);
      expect(r.err).toContain("Budget stops the turn before the next request.");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-TUI-05
  test("stream-json output validates against stream schema", async () => {
    const { StreamJson } = await import("./headless-output.ts");
    const { dir, ...r } = await headless(["-p", "hi", "--output", "stream-json"]);
    try {
      expect(r.code).toBe(0);
      const lines = r.out
        .trim()
        .split("\n")
        .filter((l) => l.trim() !== "");
      expect(lines.length).toBeGreaterThan(1);
      const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
      expect(types).toContain("session.start");
      expect(types).toContain("turn.end");
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(StreamJson.safeParse(parsed).success).toBe(true);
      }
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CLI-19
  test("--offline refuses WebFetch and WebSearch with offlineRefusal message and keeps network blackholed", async () => {
    const { offlineRefusal } = await import("./startup.ts");
    const delta = (d: unknown, finish: string | null = null) => ({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "test/model",
      choices: [{ index: 0, delta: d, finish_reason: finish }],
    });
    let modelHits = 0;
    let nonModelHits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (req.url.includes("chat/completions")) {
          modelHits += 1;
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              if (modelHits === 1) {
                // Return tool calls for WebFetch and WebSearch
                const chunk = delta({
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "wf1",
                      type: "function",
                      function: { name: "WebFetch", arguments: JSON.stringify({ url: "https://example.com" }) },
                    },
                    {
                      index: 1,
                      id: "ws1",
                      type: "function",
                      function: { name: "WebSearch", arguments: JSON.stringify({ query: "example" }) },
                    },
                  ],
                });
                controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                controller.enqueue(enc.encode(`data: ${JSON.stringify(delta({}, "tool_calls"))}\n\n`));
              } else {
                controller.enqueue(
                  enc.encode(`data: ${JSON.stringify(delta({ role: "assistant", content: "done" }))}\n\n`),
                );
                controller.enqueue(enc.encode(`data: ${JSON.stringify(delta({}, "stop"))}\n\n`));
              }
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        nonModelHits += 1;
        return new Response("blocked", { status: 500 });
      },
    });
    servers.push(server);
    const dir = await tempProject({
      "config/settings.json": JSON.stringify({
        provider: "nvidia",
        model: "test/model",
        providers: { nvidia: { baseUrl: `http://127.0.0.1:${server.port}/v1` } },
      }),
    });
    try {
      const proc = Bun.spawn([process.execPath, MAIN, "-p", "fetch doc", "--offline"], {
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
      expect(code).toBe(0);
      expect(err).toContain("offline mode");
      expect(out).toContain("done");
      expect(nonModelHits).toBe(0);
      const os = testOs();
      const sessions = await listSessions({ data: join(dir.root, "data"), projectRoot: dir.root, os });
      const last = sessions[sessions.length - 1];
      if (last === undefined) throw new Error("no session was saved");
      const read = await readSession({ data: join(dir.root, "data"), projectRoot: dir.root, os, session: last.id });
      const toolResults = read.events.filter((e) => e.type === "tool.result");
      expect(toolResults.length).toBe(2);
      const outputs = toolResults.map((r) => (r.data as { output: string }).output);
      expect(outputs.some((o) => o.includes(offlineRefusal("WebFetch")))).toBe(true);
      expect(outputs.some((o) => o.includes(offlineRefusal("WebSearch")))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });
});

describe("dovet -p signals", () => {
  const servers: Array<{ stop(): void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
  });

  const testOs = (): Os =>
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";

  const PID_FILE = "dovet-child.pid";
  const LONG_COMMAND = `echo $$ > ${PID_FILE}; sleep 30`;
  const TRAP_COMMAND = `trap '' TERM; echo $$ > ${PID_FILE}; sleep 30`;

  async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(25);
    }
  }

  function childAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function lastSessionLoc(dir: { root: string }) {
    const os = testOs();
    const sessions = await listSessions({ data: join(dir.root, "data"), projectRoot: dir.root, os });
    const last = sessions[sessions.length - 1];
    if (last === undefined) throw new Error("no session was saved");
    return { data: join(dir.root, "data"), projectRoot: dir.root, os, session: last.id };
  }

  // spec: AC-LOOP-09
  test.skipIf(process.platform === "win32")(
    "SIGTERM during a running tool kills the child, flushes the log and exits 143",
    async () => {
      const server = startFixtureServer([
        toolCallExchange({ id: "call_1", name: "Bash", args: { command: LONG_COMMAND } }),
      ]);
      servers.push(server);
      const dir = await tempProject({
        "config/settings.json": JSON.stringify({
          provider: "nvidia",
          model: "test/model",
          providers: { nvidia: { baseUrl: server.baseURL } },
        }),
      });
      try {
        const proc = spawnHeadless(dir, ["-p", "run it", "--permission-mode", "bypassPermissions"]);
        const pidPath = join(dir.root, PID_FILE);
        await until(
          async () =>
            Number(
              (
                await Bun.file(pidPath)
                  .text()
                  .catch(() => "")
              ).trim(),
            ) > 0,
          "the tool child to write its pid",
        );
        const childPid = Number((await Bun.file(pidPath).text()).trim());
        expect(childPid).toBeGreaterThan(0);
        process.kill(proc.pid, "SIGTERM");
        const [, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(143);
        expect(err).not.toContain("the session log is closed");
        await until(() => !childAlive(childPid), "the tool child to die");
        const loc = await lastSessionLoc(dir);
        const lines = (await readFile(sessionPaths(loc).log, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { type: string });
        const calls = lines.filter((l) => l.type === "tool.call");
        expect(calls).toHaveLength(1);
        expect(lines.some((l) => l.type === "tool.result")).toBe(false);
        expect(lines.some((l) => l.type === "turn.end")).toBe(false);
        expect(await Bun.file(sessionPaths(loc).lock).exists()).toBe(false);
        const resumed = await resumeSession(loc);
        expect(resumed.readOnly).toBeUndefined();
        const repaired = resumed.repairs.find(
          (r) => r.type === "tool.result" && (r.data as { callId?: string }).callId === "call_1",
        );
        expect(repaired?.data).toMatchObject({ status: "interrupted", output: CRASH_TOOL_TEXT });
        expect(resumed.repairs.at(-2)?.data).toMatchObject({ reason: "crashed" });
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-LOOP-09
  test.skipIf(process.platform === "win32")(
    "SIGTERM still ends a child that ignores SIGTERM before exiting 143",
    async () => {
      const server = startFixtureServer([
        toolCallExchange({ id: "call_trap", name: "Bash", args: { command: TRAP_COMMAND } }),
      ]);
      servers.push(server);
      const dir = await tempProject({
        "config/settings.json": JSON.stringify({
          provider: "nvidia",
          model: "test/model",
          providers: { nvidia: { baseUrl: server.baseURL } },
        }),
      });
      try {
        const proc = spawnHeadless(dir, ["-p", "run it", "--permission-mode", "bypassPermissions"]);
        const pidPath = join(dir.root, PID_FILE);
        await until(
          async () =>
            Number(
              (
                await Bun.file(pidPath)
                  .text()
                  .catch(() => "")
              ).trim(),
            ) > 0,
          "the tool child to write its pid",
        );
        const childPid = Number((await Bun.file(pidPath).text()).trim());
        expect(childPid).toBeGreaterThan(0);
        process.kill(proc.pid, "SIGTERM");
        const [, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(143);
        expect(err).not.toContain("the session log is closed");
        await until(() => !childAlive(childPid), "the SIGTERM-ignoring child to be killed");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-LOOP-02
  test.skipIf(process.platform === "win32")(
    "SIGINT aborts the running tool, warns about a second press, and exits 130 with the turn interrupted",
    async () => {
      const server = startFixtureServer([
        toolCallExchange({ id: "call_2", name: "Bash", args: { command: LONG_COMMAND } }),
      ]);
      servers.push(server);
      const dir = await tempProject({
        "config/settings.json": JSON.stringify({
          provider: "nvidia",
          model: "test/model",
          providers: { nvidia: { baseUrl: server.baseURL } },
        }),
      });
      try {
        const proc = spawnHeadless(dir, ["-p", "run it", "--permission-mode", "bypassPermissions"]);
        await until(() => Bun.file(join(dir.root, PID_FILE)).exists(), "the tool child to start");
        process.kill(proc.pid, "SIGINT");
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(130);
        expect(err).toContain("press Ctrl+C again");
        expect(err).not.toContain("dovet: aborted");
        expect(err).not.toMatch(/^dovet: *$/m);
        expect(out).toBe("");
        const read = await readSession(await lastSessionLoc(dir));
        const calls = read.events.filter((e) => e.type === "tool.call").map((e) => e.data as { callId: string });
        expect(calls).toHaveLength(1);
        const results = read.events
          .filter((e) => e.type === "tool.result")
          .map((e) => e.data as { callId: string; status: string; output: string });
        expect(results).toHaveLength(1);
        expect(results[0]?.callId).toBe(calls[0]?.callId);
        expect(results[0]?.status).toBe("interrupted");
        expect(results[0]?.output).toContain(INTERRUPTED_TOOL_TEXT);
        const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
        expect(ends.at(-1)?.reason).toBe("interrupted");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-LOOP-02 (the second-press window: a SIGINT during the retry backoff must not wait it out)
  test.skipIf(process.platform === "win32")(
    "SIGINT during a retry backoff exits 130 without waiting the backoff out",
    async () => {
      const server = startScriptedServer([
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
          steps: [{ send: JSON.stringify({ error: { message: "Too many requests" } }) }, { wait: 150 }],
        },
      ]);
      servers.push(server);
      const dir = await tempProject({
        "config/settings.json": JSON.stringify({
          provider: "nvidia",
          model: "test/model",
          providers: { nvidia: { baseUrl: server.baseURL } },
        }),
      });
      try {
        const started = Date.now();
        const proc = spawnHeadless(dir, ["-p", "hi"]);
        await until(() => server.received.length === 1, "the provider request");
        await Bun.sleep(400); // let the 429 land and the 30 s backoff start
        process.kill(proc.pid, "SIGINT");
        const [, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(130);
        expect(err).toContain("press Ctrl+C again");
        expect(err).not.toContain("dovet: aborted");
        expect(err).not.toMatch(/^dovet: *$/m);
        expect(Date.now() - started).toBeLessThan(20_000);
        const read = await readSession(await lastSessionLoc(dir));
        const ends = read.events.filter((e) => e.type === "turn.end").map((e) => e.data as { reason: string });
        expect(ends.at(-1)?.reason).toBe("cancelled");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );
});

describe("dovet -p workspace trust", () => {
  const ALLOW = JSON.stringify({ permissions: { allow: ["Bash(touch made.txt)"] } });

  const servers: Array<{ stop(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((x) => x.stop()));
  });

  const git = async (cwd: string, ...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
    expect(await proc.exited).toBe(0);
  };

  async function run(files: Record<string, string>, prepare?: (root: string) => Promise<void>) {
    const server = startFixtureServer([
      toolCallExchange({ id: "call_1", name: "Bash", args: { command: "touch made.txt" } }),
      replyExchange(),
    ]);
    servers.push(server);
    const dir = await tempProject({
      "config/settings.json": JSON.stringify({
        provider: "nvidia",
        model: "test/model",
        providers: { nvidia: { baseUrl: server.baseURL } },
      }),
      ...files,
    });
    await prepare?.(dir.root);
    const proc = spawnHeadless(dir, ["-p", "go"]);
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const made = await Bun.file(join(dir.root, "made.txt")).exists();
    return { dir, err, code, made };
  }

  // spec: AC-CLI-02
  test.skipIf(process.platform === "win32")(
    "headless ignores an untrusted project's allow rule and says so on stderr",
    async () => {
      const { dir, err, code, made } = await run({ ".dovet/settings.json": ALLOW });
      try {
        expect(code).toBe(0);
        expect(made).toBe(false);
        expect(err).toContain("this folder isn't trusted, so 1 allow rules");
        expect(err).toContain("permissions.allow");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-CLI-02
  test.skipIf(process.platform === "win32")(
    "the same rule applies once the folder is trusted for exactly that config",
    async () => {
      const { dir, err, code, made } = await run({ ".dovet/settings.json": ALLOW }, async (root) => {
        const hash = await projectConfigHash({ projectRoot: root, includeLocal: false });
        await recordTrust({
          dataDir: join(root, "data"),
          store: {},
          root,
          hash,
          trusted: true,
          home: homedir(),
          os: hostOs(),
        });
      });
      try {
        expect(code).toBe(0);
        expect(made).toBe(true);
        expect(err).not.toContain("isn't trusted");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-PERM-13
  test.skipIf(process.platform === "win32")(
    "trust recorded for an older version of the config no longer applies",
    async () => {
      const { dir, err, made } = await run({ ".dovet/settings.json": ALLOW }, async (root) => {
        await recordTrust({
          dataDir: join(root, "data"),
          store: {},
          root,
          hash: "stale",
          trusted: true,
          home: homedir(),
          os: hostOs(),
        });
      });
      try {
        expect(made).toBe(false);
        expect(err).toContain("isn't trusted");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-PERM-13
  test.skipIf(process.platform === "win32")(
    "a settings.local.json that git tracks is as untrusted as the shared file",
    async () => {
      const { dir, err, made } = await run({ ".dovet/settings.local.json": ALLOW }, async (root) => {
        await git(root, "init", "-q");
        await git(root, "add", "-f", ".dovet/settings.local.json");
      });
      try {
        expect(made).toBe(false);
        expect(err).toContain("settings.local.json");
        expect(err).toContain("isn't trusted");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-PERM-13
  test.skipIf(process.platform === "win32")(
    "a settings.local.json Dovet saved is trusted without a dialog",
    async () => {
      const { dir, err, made } = await run({}, async (root) => {
        await git(root, "init", "-q");
        await saveLocalRule(root, "allow", "Bash(touch made.txt)", { dataDir: join(root, "data"), os: hostOs() });
      });
      try {
        expect(made).toBe(true);
        expect(err).not.toContain("isn't trusted");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-PERM-13
  test.skipIf(process.platform === "win32")(
    "a gitignored settings.local.json that Dovet didn't write is untrusted",
    async () => {
      const { dir, err, made } = await run(
        { ".dovet/settings.local.json": ALLOW, ".gitignore": ".dovet/settings.local.json\n" },
        (root) => git(root, "init", "-q"),
      );
      try {
        expect(made).toBe(false);
        expect(err).toContain("settings.local.json");
        expect(err).toContain("isn't trusted");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-PERM-13
  test.skipIf(process.platform === "win32")(
    "outside git a settings.local.json could have come from an unpacked archive, so it is untrusted",
    async () => {
      const { dir, err, made } = await run({ ".dovet/settings.local.json": ALLOW });
      try {
        expect(made).toBe(false);
        expect(err).toContain("isn't trusted");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );

  // spec: AC-PERM-13
  test.skipIf(process.platform === "win32")(
    "terminal escapes in a repo's settings keys are printed as text",
    async () => {
      const key = "\u001b[2K\u001b]0;owned\u0007";
      const { dir, err } = await run({ ".dovet/settings.json": JSON.stringify({ env: { [key]: "x" } }) });
      try {
        expect(err).toContain("isn't trusted");
        expect(err).not.toContain("\u001b");
        expect(err).toContain("\\u{1b}[2K");
      } finally {
        await dir.dispose();
      }
    },
    30_000,
  );
});
