// Session boot of a headless turn: the sandbox service and the instruction files (permissions §7, context §3).
import { describe, expect, test } from "bun:test";
import { chmod, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fakePlatform, sequentialIds, type TempProject, tempProject } from "../../test/helpers/index.ts";
import type { Os } from "../platform/index.ts";
import type { SandboxService } from "../policy/index.ts";
import type { Settings } from "../schema/index.ts";
import type { LoadedSettings } from "../store/index.ts";
import { readSession } from "../store/index.ts";
import type { ToolDefinition } from "../tools/index.ts";
import { type HeadlessAdapter, runHeadless } from "./headless-run.ts";

const testOs = (): Os => (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
const ENV: Record<string, string | undefined> = { NVIDIA_API_KEY: "nvapi-FAKE", HOME: "/tmp" };

function settingsFor(extra: Settings = {}): LoadedSettings {
  return {
    settings: { provider: "nvidia", model: "test/model", ...extra } as LoadedSettings["settings"],
    rules: { allow: [], ask: [], deny: [] },
    warnings: [],
    notices: [],
    files: [],
    untrusted: [],
  };
}

type Step = { calls?: { id: string; name: string; input: unknown }[]; text?: string };

function scripted(steps: Step[]): HeadlessAdapter {
  let next = 0;
  return {
    render: () => ({
      provider: "nvidia",
      package: "x",
      modelId: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [],
      providerOptions: {},
    }),
    stream: async function* () {
      const step = steps[next];
      next += 1;
      if (step === undefined) throw new Error("script exhausted");
      yield {
        type: "done",
        stopReason: step.calls === undefined ? "end_turn" : "tool_use",
        stored: {
          provider: "nvidia",
          protocol: "openai-chat",
          package: "x",
          packageVersion: "1",
          modelId: "m",
          parts: [
            ...(step.calls ?? []).map((c) => ({
              kind: "tool_call",
              id: c.id,
              name: c.name,
              inputJson: JSON.stringify(c.input),
            })),
            ...(step.text === undefined ? [] : [{ kind: "text", text: step.text }]),
          ],
          usage: {},
          finishReason: step.calls === undefined ? "stop" : "tool_calls",
        },
      };
    },
  } as never;
}

function tool(
  name: string,
  run: (input: { text: string }, ctx: Parameters<ToolDefinition<unknown>["run"]>[1]) => unknown,
) {
  return {
    name,
    input: z.strictObject({ text: z.string() }),
    descriptionFile: "tools/Read.md",
    errorExample: { text: "hi" },
    parallelSafe: true,
    mutates: "none",
    describeAction: () => ({
      kind: "read",
      paths: [],
      effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
    }),
    run: async (input: unknown, ctx: Parameters<ToolDefinition<unknown>["run"]>[1]) => {
      await run(input as { text: string }, ctx);
      return { status: "ok", content: [{ kind: "text", text: "ok" }] };
    },
  } as ToolDefinition<unknown>;
}

function fakeManager(opts: { errors?: string[]; globs?: string[]; reset?: () => void } = {}) {
  return async () =>
    ({
      checkDependencies: () => ({ errors: opts.errors ?? [], warnings: [] }),
      getLinuxGlobPatternWarnings: () => opts.globs ?? [],
      wrapWithSandbox: async (cmd: string) => `echo WRAPPED; ${cmd}`,
      cleanupAfterCommand: () => {},
      getSandboxViolationStore: () => ({ getViolations: () => [] }),
      reset: async () => opts.reset?.(),
    }) as never;
}

type Overrides = Partial<Parameters<typeof runHeadless>[0]>;

function boot(dir: TempProject, steps: Step[], overrides: Overrides = {}, prompt = "go", extraArgs = {}) {
  return runHeadless({
    dirs: { config: join(dir.root, "cfg"), data: join(dir.root, "data"), cache: join(dir.root, "cache") },
    projectRoot: dir.root,
    cwd: dir.root,
    os: testOs(),
    settings: settingsFor(),
    env: ENV,
    loadInput: {
      dirs: { config: join(dir.root, "cfg") },
      home: join(dir.root, "home"),
      projectRoot: dir.root,
      env: ENV,
      trust: { project: true, local: true },
    },
    args: {
      print: true,
      output: "text",
      offline: false,
      noSessionPersistence: false,
      continued: false,
      repair: false,
      allowedTools: [],
      disallowedTools: [],
      ...extraArgs,
    },
    prompt,
    clock: { now: () => Date.UTC(2026, 9, 15) },
    ids: sequentialIds("B"),
    pid: 1,
    host: "h",
    platform: fakePlatform(),
    adapter: scripted(steps),
    ...overrides,
  });
}

const eventsOf = async (dir: TempProject, sessionId: string) =>
  (await readSession({ data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: sessionId })).events;

type Events = Awaited<ReturnType<typeof eventsOf>>;

function dataOf<T>(events: Events, type: string): T {
  const found = events.find((e) => e.type === type);
  if (found === undefined) throw new Error(`no ${type} event`);
  return found.data as T;
}

const systemTextOf = (events: Events): string => dataOf<{ systemText: string }>(events, "epoch.start").systemText;

describe("headless boot: the sandbox", () => {
  // spec: permissions §7.1
  test("a shell tool gets the session's real sandbox service, and the sandbox is shut down after the turn", async () => {
    const dir = await tempProject({});
    try {
      let seen: SandboxService | undefined;
      let wrapped: string[] = [];
      let resets = 0;
      const out = await boot(dir, [{ calls: [{ id: "c1", name: "Bash", input: { text: "x" } }] }, { text: "done" }], {
        toolDefs: [
          tool("Bash", async (_i, ctx) => {
            seen = ctx.sandbox;
            await ctx.sandbox?.ready;
            wrapped =
              (await ctx.sandbox?.wrap({ argv: ["echo", "hi"], cwd: dir.root, env: {} }, { unsandboxed: false }))
                ?.argv ?? [];
          }),
        ],
        sandboxStarter: fakeManager({ reset: () => (resets += 1) }),
      });
      expect(out.exit).toEqual({ kind: "ok" });
      // Windows keeps the sandbox off until its escape suite passes (QUESTIONS Q59, Q68).
      expect(seen?.state).toBe(testOs() === "win32" ? "off" : "on");
      expect(seen?.backend).toBe(testOs() === "linux" ? "bubblewrap" : testOs() === "darwin" ? "seatbelt" : "none");
      if (testOs() !== "win32") expect(wrapped.join(" ")).toContain("echo WRAPPED; 'echo' 'hi'");
      expect(resets).toBe(testOs() === "win32" ? 0 : 1);
    } finally {
      await dir.dispose();
    }
  });

  // spec: permissions §7.1
  test.skipIf(process.platform === "win32")("sandbox.enabled false builds no service at all", async () => {
    const dir = await tempProject({});
    try {
      let seen: SandboxService | undefined = {} as SandboxService;
      let started = 0;
      await boot(dir, [{ calls: [{ id: "c1", name: "Bash", input: { text: "x" } }] }, { text: "done" }], {
        settings: settingsFor({ sandbox: { enabled: false } }),
        toolDefs: [tool("Bash", (_i, ctx) => (seen = ctx.sandbox))],
        sandboxStarter: async () => {
          started += 1;
          return fakeManager()();
        },
      });
      expect(seen).toBeUndefined();
      expect(started).toBe(0);
    } finally {
      await dir.dispose();
    }
  });

  // spec: permissions §7.2
  test.skipIf(process.platform === "win32")(
    "glob warnings and ambiguous hosts reach the startup warnings once a shell command ran",
    async () => {
      const dir = await tempProject({});
      try {
        const out = await boot(dir, [{ calls: [{ id: "c1", name: "Bash", input: { text: "x" } }] }, { text: "done" }], {
          settings: settingsFor({ sandbox: { network: { allowedDomains: ["a..b"] } } }),
          toolDefs: [tool("Bash", async (_i, ctx) => void (await ctx.sandbox?.ready))],
          sandboxStarter: fakeManager({ globs: ["pattern ** is not supported on Linux"] }),
        });
        expect(out.warnings).toContain("pattern ** is not supported on Linux");
        expect(out.warnings).toContain("ambiguous host a..b (see /doctor)");
      } finally {
        await dir.dispose();
      }
    },
  );

  // spec: permissions §7.6
  test.skipIf(process.platform === "win32")("an unavailable sandbox is reported, never silent", async () => {
    const dir = await tempProject({});
    try {
      const out = await boot(dir, [{ calls: [{ id: "c1", name: "Bash", input: { text: "x" } }] }, { text: "done" }], {
        toolDefs: [tool("Bash", async (_i, ctx) => void (await ctx.sandbox?.ready))],
        sandboxStarter: fakeManager({ errors: ["bwrap missing"] }),
      });
      expect(out.warnings).toContain("sandbox: off (commands judged by text)");
    } finally {
      await dir.dispose();
    }
  });
});

describe("headless boot: instruction files", () => {
  // spec: AC-CTX-06
  test("a new session's system prompt carries the project's instruction files, root first, and logs what loaded", async () => {
    const dir = await tempProject({
      "AGENTS.md": "ROOT RULES\n",
      "CLAUDE.md": "CLAUDE RULES\n",
      "cfg/AGENTS.md": "USER RULES\n",
    });
    try {
      const out = await boot(dir, [{ text: "done" }]);
      const events = await eventsOf(dir, out.sessionId);
      const system = systemTextOf(events);
      expect(system).toContain("## Project instructions");
      expect(system).toContain("USER RULES");
      expect(system.indexOf("USER RULES")).toBeLessThan(system.indexOf("CLAUDE RULES"));
      expect(system.indexOf("CLAUDE RULES")).toBeLessThan(system.indexOf("ROOT RULES"));
      const paths = dataOf<{ files: { path: string }[] }>(events, "instructions.loaded").files.map((f) => f.path);
      expect(paths.some((p) => p.endsWith("AGENTS.md"))).toBe(true);
      expect(paths.some((p) => p.endsWith("CLAUDE.md"))).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-16
  test.skipIf(process.platform === "win32")(
    "an external import is skipped in headless, and nothing is recorded as declined",
    async () => {
      const dir = await tempProject({ "AGENTS.md": "see @OUTSIDE_PLACEHOLDER\n" });
      const outside = await tempProject({ "secret.md": "OUTSIDE CONTENT\n" });
      try {
        await writeFile(join(dir.root, "AGENTS.md"), `see @${join(outside.root, "secret.md")}\n`);
        const out = await boot(dir, [{ text: "done" }]);
        expect(systemTextOf(await eventsOf(dir, out.sessionId))).not.toContain("OUTSIDE CONTENT");
        expect(out.warnings.join("\n")).toContain("external import");
        const stored = await Array.fromAsync(
          new Bun.Glob("**/external-imports.json").scan({ cwd: join(dir.root, "data") }),
        );
        expect(stored).toEqual([]);
      } finally {
        await outside.dispose();
        await dir.dispose();
      }
    },
  );

  // spec: permissions §10
  test("hidden characters in an instruction file taint the session and are logged", async () => {
    const dir = await tempProject({ "AGENTS.md": "be nice\u{E0041}\u{E0042}\n" });
    try {
      const out = await boot(dir, [{ text: "done" }]);
      const events = await eventsOf(dir, out.sessionId);
      expect(dataOf<{ source: string }>(events, "taint.change").source.endsWith("AGENTS.md")).toBe(true);
      expect(out.warnings.join("\n")).toContain("hidden characters removed");
      expect(systemTextOf(events)).not.toContain("\u{E0041}");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-10
  test("on resume the system prompt is untouched and an edited file is appended as an instruction", async () => {
    const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
    try {
      const ids = sequentialIds("B");
      const first = await boot(dir, [{ text: "one" }], { ids });
      const before = systemTextOf(await eventsOf(dir, first.sessionId));
      await writeFile(join(dir.root, "AGENTS.md"), "NEW RULE\n");
      const second = await boot(dir, [{ text: "two" }], { ids }, "again", { resume: first.sessionId });
      const events = await eventsOf(dir, second.sessionId);
      expect(systemTextOf(events)).toBe(before);
      const injected = events
        .filter((e) => e.type === "system.injected")
        .map((e) => e.data as { text: string; reason: string });
      expect(injected.map((i) => i.reason)).toEqual(["instructions-updated"]);
      expect(injected[0]?.text).toContain("Instructions updated (AGENTS.md):\nNEW RULE");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-10
  test("a file the agent edits mid-turn is appended before the next request", async () => {
    const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
    try {
      const out = await boot(dir, [{ calls: [{ id: "c1", name: "echo", input: { text: "x" } }] }, { text: "done" }], {
        toolDefs: [
          tool("echo", async () => {
            const file = join(dir.root, "AGENTS.md");
            await writeFile(file, "MID TURN RULE\n");
            await utimes(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
          }),
        ],
      });
      const events = await eventsOf(dir, out.sessionId);
      const injected = events.filter((e) => e.type === "system.injected").map((e) => (e.data as { text: string }).text);
      expect(injected).toHaveLength(1);
      expect(injected[0]).toContain("MID TURN RULE");
      expect(systemTextOf(events)).toContain("OLD RULE");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-16
  test("a Read deny rule keeps a file out of the system prompt", async () => {
    const files = { "AGENTS.md": "SECRET RULES\n" };
    const open = await tempProject(files);
    const closed = await tempProject({
      ...files,
      "cfg/settings.json": JSON.stringify({ permissions: { deny: ["Read(./AGENTS.md)"] } }),
    });
    try {
      const control = await boot(open, [{ text: "done" }]);
      expect(systemTextOf(await eventsOf(open, control.sessionId))).toContain("SECRET RULES");
      const out = await boot(closed, [{ text: "done" }]);
      expect(systemTextOf(await eventsOf(closed, out.sessionId))).not.toContain("SECRET RULES");
    } finally {
      await closed.dispose();
      await open.dispose();
    }
  });

  // spec: permissions §10
  test("a file the agent rewrites mid-turn with hidden characters is scrubbed and taints the session", async () => {
    const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
    try {
      const out = await boot(dir, [{ calls: [{ id: "c1", name: "echo", input: { text: "x" } }] }, { text: "done" }], {
        toolDefs: [
          tool("echo", async () => {
            const file = join(dir.root, "AGENTS.md");
            await writeFile(file, "MID \u{E0041}\u{E0042}\u{200B} RULE\n");
            await utimes(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
          }),
        ],
      });
      const events = await eventsOf(dir, out.sessionId);
      const injected = events.filter((e) => e.type === "system.injected").map((e) => (e.data as { text: string }).text);
      expect(injected).toHaveLength(1);
      expect(injected[0]).toContain("MID");
      expect(injected[0]).not.toContain("\u{E0041}");
      expect(dataOf<{ source: string }>(events, "taint.change").source.endsWith("AGENTS.md")).toBe(true);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-16
  test.skipIf(process.platform === "win32")(
    "a file the agent swaps for a link to a Read-denied file is not sent to the model",
    async () => {
      const dir = await tempProject({
        "AGENTS.md": "OLD RULE\n",
        "secret.txt": "TOPSECRET\n",
        "cfg/settings.json": JSON.stringify({ permissions: { deny: ["Read(./secret.txt)"] } }),
      });
      try {
        const out = await boot(dir, [{ calls: [{ id: "c1", name: "echo", input: { text: "x" } }] }, { text: "done" }], {
          toolDefs: [
            tool("echo", async () => {
              await rm(join(dir.root, "AGENTS.md"));
              await symlink(join(dir.root, "secret.txt"), join(dir.root, "AGENTS.md"));
            }),
          ],
        });
        const events = await eventsOf(dir, out.sessionId);
        expect(JSON.stringify(events)).not.toContain("TOPSECRET");
      } finally {
        await dir.dispose();
      }
    },
  );

  // spec: AC-CTX-16
  test.skipIf(process.platform === "win32")(
    "started below the project root, the root's instruction files are still project files: external imports stay skipped",
    async () => {
      const dir = await tempProject({ "pkg/.keep": "" });
      const outside = await tempProject({ "secret.md": "OUTSIDE CONTENT\n" });
      try {
        await writeFile(join(dir.root, "AGENTS.md"), `see @${join(outside.root, "secret.md")}\n`);
        const out = await boot(dir, [{ text: "done" }], { cwd: join(dir.root, "pkg") });
        expect(systemTextOf(await eventsOf(dir, out.sessionId))).not.toContain("OUTSIDE CONTENT");
      } finally {
        await outside.dispose();
        await dir.dispose();
      }
    },
  );

  // spec: permissions §10
  test("instruction files with hidden characters make a remote action fail", async () => {
    const pushTool = {
      name: "Bash",
      input: z.strictObject({}),
      descriptionFile: "tools/Read.md",
      errorExample: {},
      parallelSafe: false,
      mutates: "none",
      describeAction: () => ({
        kind: "shell",
        shell: "bash",
        command: "git push origin main",
        sandboxed: false,
        unsandboxedRetry: false,
        effects: { writes: "none", network: "none", sensitiveReads: [], remote: ["push"], sandboxed: false },
      }),
      run: async () => ({ status: "ok", content: [{ kind: "text", text: "pushed" }] }),
    } as ToolDefinition<unknown>;
    const resultOf = async (files: Record<string, string>): Promise<string> => {
      const dir = await tempProject(files);
      try {
        const out = await boot(dir, [{ calls: [{ id: "c1", name: "Bash", input: {} }] }, { text: "done" }], {
          toolDefs: [pushTool],
          sandboxStarter: fakeManager(),
        });
        const events = await eventsOf(dir, out.sessionId);
        return dataOf<{ output: string }>(events, "tool.result").output;
      } finally {
        await dir.dispose();
      }
    };
    const allow = { "cfg/settings.json": JSON.stringify({ permissions: { allow: ["Bash(git push origin main)"] } }) };
    const clean = await resultOf({ ...allow, "AGENTS.md": "be nice\n" });
    const tainted = await resultOf({ ...allow, "AGENTS.md": "be nice\u{E0041}\n" });
    expect(tainted).toBe("Permission denied: remote action: git push");
    expect(clean).toBe("pushed");
  });

  // spec: AC-CTX-10
  test("a launch file the agent deletes mid-turn is announced as gone", async () => {
    const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
    try {
      const out = await boot(dir, [{ calls: [{ id: "c1", name: "echo", input: { text: "x" } }] }, { text: "done" }], {
        toolDefs: [tool("echo", () => rm(join(dir.root, "AGENTS.md")))],
      });
      const events = await eventsOf(dir, out.sessionId);
      const injected = events.filter((e) => e.type === "system.injected").map((e) => (e.data as { text: string }).text);
      expect(injected).toEqual([
        "Instructions updated (AGENTS.md):\n(the file was deleted or can no longer be loaded)",
      ]);
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-10
  test("a launch file deleted and restored with the same text within a turn is announced again", async () => {
    const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
    try {
      const file = join(dir.root, "AGENTS.md");
      const steps: Step[] = [
        { calls: [{ id: "c1", name: "gone", input: { text: "x" } }] },
        { calls: [{ id: "c2", name: "back", input: { text: "x" } }] },
        { text: "done" },
      ];
      const out = await boot(dir, steps, {
        toolDefs: [tool("gone", () => rm(file)), tool("back", () => writeFile(file, "OLD RULE\n"))],
      });
      const events = await eventsOf(dir, out.sessionId);
      const injected = events.filter((e) => e.type === "system.injected").map((e) => (e.data as { text: string }).text);
      expect(injected).toHaveLength(2);
      expect(injected[0]).toContain("the file was deleted");
      expect(injected[1]).toContain("OLD RULE");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-10
  test.skipIf(process.platform === "win32")(
    "a launch file replaced by a symlink loop after it was dropped does not crash the turn",
    async () => {
      const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
      try {
        const file = join(dir.root, "AGENTS.md");
        const steps: Step[] = [
          { calls: [{ id: "c1", name: "gone", input: { text: "x" } }] },
          { calls: [{ id: "c2", name: "loop", input: { text: "x" } }] },
          { text: "done" },
        ];
        const out = await boot(dir, steps, {
          toolDefs: [tool("gone", () => rm(file)), tool("loop", () => symlink("AGENTS.md", file))],
        });
        expect(out.exit).toEqual({ kind: "ok" });
      } finally {
        await dir.dispose();
      }
    },
  );

  // spec: AC-CTX-10
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a launch file the agent makes unreadable mid-turn is announced as gone and does not crash the turn",
    async () => {
      const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
      const file = join(dir.root, "AGENTS.md");
      try {
        const out = await boot(dir, [{ calls: [{ id: "c1", name: "lock", input: { text: "x" } }] }, { text: "done" }], {
          toolDefs: [
            tool("lock", async () => {
              await writeFile(file, "NEW RULE\n");
              await chmod(file, 0);
            }),
          ],
        });
        expect(out.exit).toEqual({ kind: "ok" });
        const injected = (await eventsOf(dir, out.sessionId))
          .filter((e) => e.type === "system.injected")
          .map((e) => (e.data as { text: string }).text);
        expect(injected).toEqual([
          "Instructions updated (AGENTS.md):\n(the file was deleted or can no longer be loaded)",
        ]);
      } finally {
        await chmod(file, 0o644).catch(() => undefined);
        await dir.dispose();
      }
    },
  );

  // spec: AC-CTX-10
  test("a file deleted mid-turn and back with the same text is injected again on resume", async () => {
    const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
    try {
      const ids = sequentialIds("B");
      const file = join(dir.root, "AGENTS.md");
      const first = await boot(dir, [{ calls: [{ id: "c1", name: "gone", input: { text: "x" } }] }, { text: "one" }], {
        ids,
        toolDefs: [tool("gone", () => rm(file))],
      });
      await writeFile(file, "OLD RULE\n");
      const second = await boot(dir, [{ text: "two" }], { ids }, "again", { resume: first.sessionId });
      const injected = (await eventsOf(dir, second.sessionId))
        .filter((e) => e.type === "system.injected")
        .map((e) => (e.data as { text: string }).text);
      expect(injected).toHaveLength(2);
      expect(injected[1]).toContain("OLD RULE");
    } finally {
      await dir.dispose();
    }
  });

  // spec: AC-CTX-10
  test("an update made mid-turn is not announced again when the session is resumed", async () => {
    const dir = await tempProject({ "AGENTS.md": "OLD RULE\n" });
    try {
      const ids = sequentialIds("B");
      const first = await boot(dir, [{ calls: [{ id: "c1", name: "echo", input: { text: "x" } }] }, { text: "one" }], {
        ids,
        toolDefs: [
          tool("echo", async () => {
            const file = join(dir.root, "AGENTS.md");
            await writeFile(file, "NEW RULE\n");
            await utimes(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
          }),
        ],
      });
      const second = await boot(dir, [{ text: "two" }], { ids }, "again", { resume: first.sessionId });
      const injected = (await eventsOf(dir, second.sessionId))
        .filter((e) => e.type === "system.injected")
        .map((e) => (e.data as { text: string }).text);
      expect(injected).toHaveLength(1);
    } finally {
      await dir.dispose();
    }
  });
});

describe("headless boot: ending the turn", () => {
  // spec: permissions §7.1
  test.skipIf(process.platform === "win32")(
    "a sandbox that never finishes starting does not hold up a turn that ran no shell command",
    async () => {
      const dir = await tempProject({});
      try {
        let resets = 0;
        let release: () => void = () => {};
        const stalled = new Promise<void>((resolve) => {
          release = resolve;
        });
        const starter = async () => {
          await stalled;
          return fakeManager({ reset: () => (resets += 1) })();
        };
        const out = await boot(dir, [{ text: "done" }], {
          toolDefs: [tool("Bash", () => undefined)],
          sandboxStarter: starter,
        });
        expect(out.exit).toEqual({ kind: "ok" });
        expect(resets).toBe(0);
        release();
        await Bun.sleep(20);
        expect(resets).toBe(1);
      } finally {
        await dir.dispose();
      }
    },
  );

  // spec: permissions §7.1
  test.skipIf(process.platform === "win32")(
    "a sandbox that fails to stop still lets the session log close",
    async () => {
      const dir = await tempProject({});
      try {
        const ids = sequentialIds("B");
        const failing = boot(dir, [{ calls: [{ id: "c1", name: "Bash", input: { text: "x" } }] }, { text: "done" }], {
          ids,
          toolDefs: [tool("Bash", async (_i, ctx) => void (await ctx.sandbox?.ready))],
          sandboxStarter: fakeManager({
            reset: () => {
              throw new Error("reset boom");
            },
          }),
        });
        await expect(failing).rejects.toThrow("reset boom");
        const again = await boot(dir, [{ text: "ok" }], { ids }, "again", { continued: true });
        expect(again.exit).toEqual({ kind: "ok" });
      } finally {
        await dir.dispose();
      }
    },
  );
});
