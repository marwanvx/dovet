import { describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Settings } from "../schema/index.ts";
import { createGlobTool, createToolRegistry, type ToolContext, type ToolOutput } from "./index.ts";
import { searchContext, text, workspace } from "./test-context.ts";

async function glob(ctx: ToolContext, input: Record<string, unknown>, tool = createGlobTool()): Promise<ToolOutput> {
  const prepared = createToolRegistry([tool]).prepare("Glob", input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, ctx);
}

async function files(cwd: string, entries: Record<string, string | number>): Promise<void> {
  for (const [name, body] of Object.entries(entries)) {
    await mkdir(join(cwd, name, ".."), { recursive: true });
    await writeFile(join(cwd, name), typeof body === "string" ? body : "x");
    if (typeof body === "number") await utimes(join(cwd, name), body, body);
  }
}

describe("Glob", () => {
  // spec: AC-TOOLS-30
  test("`*.ts` matches only top-level files and `**/*.ts` every depth; node_modules is excluded", async () => {
    const cwd = await workspace();
    await files(cwd, {
      ".gitignore": "node_modules\n",
      "a.ts": "",
      "src/b.ts": "",
      "src/deep/c.ts": "",
      "node_modules/p/d.ts": "",
      "e.js": "",
    });
    const ctx = await searchContext(cwd);
    expect(text(await glob(ctx, { pattern: "*.ts" }))).toBe("a.ts");
    expect(
      text(await glob(ctx, { pattern: "**/*.ts" }))
        .split("\n")
        .sort(),
    ).toEqual(["a.ts", join("src", "b.ts"), join("src", "deep", "c.ts")]);
    expect(text(await glob(ctx, { pattern: "src/*.{ts,js}" }))).toBe(join("src", "b.ts"));
    expect(text(await glob(ctx, { pattern: "?.js" }))).toBe("e.js");
    expect(text(await glob(ctx, { pattern: "[ab].ts" }))).toBe("a.ts");
  });

  // spec: AC-TOOLS-30
  // spec: AC-TOOLS-10
  test("a pattern that matches only ignored files returns them, marked", async () => {
    const cwd = await workspace();
    await files(cwd, { ".gitignore": "build\n", "a.txt": "", "build/out.js": "" });
    const out = await glob(await searchContext(cwd), { pattern: "build/*.js" });
    expect(text(out)).toBe(`(only in ignored files)\n${join("build", "out.js")}`);
  });

  // spec: AC-TOOLS-10
  test("a path that is itself ignored is listed in full; glob.respectGitignore false includes ignored files", async () => {
    const cwd = await workspace();
    await files(cwd, { ".gitignore": "build\n", "a.js": "", "build/out.js": "" });
    const ctx = await searchContext(cwd);
    expect(text(await glob(ctx, { pattern: "*.js", path: "build" }))).toBe(join("build", "out.js"));
    await files(cwd, { "build/.gitignore": "dist\n", "build/dist/z.js": "" });
    expect(text(await glob(ctx, { pattern: "**/z.js", path: "build" }))).toBe(join("build", "dist", "z.js"));
    const all = await glob(
      await searchContext(cwd, { settings: Settings.parse({ glob: { respectGitignore: false } }) }),
      { pattern: "**/*.js" },
    );
    expect(text(all).split("\n").sort()).toEqual(["a.js", join("build", "dist", "z.js"), join("build", "out.js")]);
  });

  // spec: AC-TOOLS-10
  test("results are capped at 100 with a flag for the rest", async () => {
    const cwd = await workspace();
    const many: Record<string, string> = {};
    for (let i = 0; i < 130; i++) many[`f${i}.txt`] = "";
    await files(cwd, many);
    const lines = text(await glob(await searchContext(cwd), { pattern: "*.txt" })).split("\n");
    expect(lines).toHaveLength(101);
    expect(lines[100]).toBe("[… 30 more; narrow the pattern]");
  });

  // spec: AC-TOOLS-30
  test("results are newest first", async () => {
    const cwd = await workspace();
    await files(cwd, { "old.txt": 1_000_000, "new.txt": 3_000_000, "mid.txt": 2_000_000 });
    expect(text(await glob(await searchContext(cwd), { pattern: "*.txt" }))).toBe("new.txt\nmid.txt\nold.txt");
  });

  // spec: AC-TOOLS-30
  test("on a case-insensitive OS `*.TS` finds a.ts through the retry; on a case-sensitive one it does not", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.ts": "" });
    const windows = process.platform === "win32";
    const insensitive = await glob(await searchContext(cwd, {}, windows ? "win32" : "darwin"), { pattern: "*.TS" });
    expect(text(insensitive)).toBe("(matched ignoring case)\na.ts");
    if (windows) return;
    const linux = await glob(await searchContext(cwd, {}, "linux"), { pattern: "*.TS" });
    expect(text(linux)).toBe("No files found.");
  });

  test("sensitive files are skipped and counted; no match says 'No files found.'", async () => {
    const cwd = await workspace();
    await files(cwd, { ".env": "", "k.pem": "", "a.txt": "" });
    const ctx = await searchContext(cwd);
    expect(text(await glob(ctx, { pattern: "*" }))).toBe("a.txt\n(2 sensitive files skipped)");
    expect(text(await glob(ctx, { pattern: "*.zzz" }))).toBe("No files found.");
  });

  test("paths relative to the working directory, also for a sub-path search", async () => {
    const cwd = await workspace();
    await files(cwd, { "src/a.ts": "" });
    expect(text(await glob(await searchContext(cwd), { pattern: "*.ts", path: "src" }))).toBe(join("src", "a.ts"));
  });

  test("a missing or non-directory path is an error", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.txt": "" });
    const ctx = await searchContext(cwd);
    expect((await glob(ctx, { pattern: "*", path: "nope" })).status).toBe("error");
    expect(text(await glob(ctx, { pattern: "*", path: "a.txt" }))).toContain("not a directory");
  });

  // spec: AC-TOOLS-33
  test("a spawn failure is an error, not 'No files found.'", async () => {
    const cwd = await workspace();
    const base = await searchContext(cwd);
    const ctx: ToolContext = {
      ...base,
      platform: {
        ...base.platform,
        spawn: () => {
          throw new Error("spawn EMFILE");
        },
      },
    };
    const out = await glob(ctx, { pattern: "*" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("spawn EMFILE");
  });

  test("a listing that hits the time limit returns partial results with the note", async () => {
    const cwd = await workspace();
    const base = await searchContext(cwd);
    const ctx: ToolContext = {
      ...base,
      platform: {
        ...base.platform,
        spawn: (cmd) =>
          base.platform.spawn({
            ...cmd,
            argv: [process.execPath, "-e", "process.stdout.write('a.txt\\n'); setInterval(() => {}, 1000);"],
          }),
      },
    };
    const out = await glob(ctx, { pattern: "*.txt" }, createGlobTool({ limits: { timeoutMs: 400 } }));
    expect(text(out)).toContain("a.txt");
    expect(text(out)).toContain("results are partial");
  });

  test("a timeout with nothing listed is not 'No files found.'", async () => {
    const cwd = await workspace();
    const base = await searchContext(cwd);
    const ctx: ToolContext = {
      ...base,
      platform: {
        ...base.platform,
        spawn: (cmd) => base.platform.spawn({ ...cmd, argv: [process.execPath, "-e", "setInterval(() => {}, 1000);"] }),
      },
    };
    const out = await glob(ctx, { pattern: "*.txt" }, createGlobTool({ limits: { timeoutMs: 300 } }));
    expect(text(out)).toContain("results are partial");
    expect(text(out)).not.toContain("No files found");
  });
});
