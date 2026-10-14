import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Settings } from "../schema/index.ts";
import { createGrepTool, createToolRegistry, type ToolContext, type ToolOutput } from "./index.ts";
import { searchContext, text, workspace } from "./test-context.ts";

async function grep(ctx: ToolContext, input: Record<string, unknown>, tool = createGrepTool()): Promise<ToolOutput> {
  const prepared = createToolRegistry([tool]).prepare("Grep", input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, ctx);
}

async function files(cwd: string, entries: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(entries)) {
    await mkdir(join(cwd, name, ".."), { recursive: true });
    await writeFile(join(cwd, name), body);
  }
}

/** Runs `script` under Bun in place of ripgrep, so a search can hang or flood on every OS. */
function fakeRg(ctx: ToolContext, script: string): ToolContext {
  return {
    ...ctx,
    platform: {
      ...ctx.platform,
      spawn: (cmd) => ctx.platform.spawn({ ...cmd, argv: [process.execPath, "-e", script] }),
    },
  };
}

describe("Grep: modes and paging", () => {
  // spec: AC-TOOLS-09
  test("count lists per-file counts and a total that covers entries cut by head_limit", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.txt": "hit\nhit\n", "b.txt": "hit\n", "c.txt": "hit\nhit\nhit\n", "d.txt": "miss\n" });
    const out = await grep(await searchContext(cwd), { pattern: "hit", output_mode: "count", head_limit: 2 });
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("a.txt:2\nb.txt:1\n");
    expect(text(out)).not.toContain("c.txt:3");
    expect(text(out)).toContain("Total: 6 matches in 3 files.");
    expect(text(out)).toContain("[Showing entries 1–2 of 3. Use offset=2 for more.]");
  });

  // spec: AC-TOOLS-09
  test("an offset past the last entry says so in every mode, never 'No matches found'", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.txt": "hit\n" });
    const ctx = await searchContext(cwd);
    for (const mode of ["files_with_matches", "content", "count"]) {
      const out = await grep(ctx, { pattern: "hit", output_mode: mode, offset: 5 });
      expect(text(out)).toContain("No entries at this offset (total 1).");
      expect(text(out)).not.toContain("No matches found");
    }
  });

  // spec: AC-TOOLS-09
  test("an invalid regex returns ripgrep's diagnostic as an error", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.txt": "x\n" });
    const out = await grep(await searchContext(cwd), { pattern: "(" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("unclosed group");
  });

  // spec: AC-TOOLS-09
  test("an unknown file type returns ripgrep's diagnostic", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.txt": "x\n" });
    const out = await grep(await searchContext(cwd), { pattern: "x", type: "nosuchtype" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("unrecognized file type");
  });

  test("content mode groups matches by file with line numbers and marks context with '-'", async () => {
    const cwd = await workspace();
    await files(cwd, { "src/a.ts": "one\ntwo\nneedle\nfour\nfive\nsix\nneedle\n", "b.ts": "needle\n" });
    const out = await grep(await searchContext(cwd), {
      pattern: "needle",
      output_mode: "content",
      "-B": 1,
      "-A": 1,
    });
    expect(text(out)).toBe("b.ts\n1:needle\n\nsrc/a.ts\n2-two\n3:needle\n4-four\n--\n6-six\n7:needle");
  });

  test("-n false drops line numbers; -i and multiline are honored", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.txt": "Alpha\nbeta\n" });
    const ctx = await searchContext(cwd);
    expect(text(await grep(ctx, { pattern: "alpha", output_mode: "content", "-n": false, "-i": true }))).toBe(
      "a.txt\nAlpha",
    );
    expect(text(await grep(ctx, { pattern: "Alpha\\nbeta", multiline: true }))).toBe("a.txt");
    expect(text(await grep(ctx, { pattern: "alpha" }))).toBe("No matches found.");
  });

  test("`-l` and `-c` flags and `file_path` are rewritten", async () => {
    const cwd = await workspace();
    await files(cwd, { "d/a.txt": "x\nx\n" });
    const ctx = await searchContext(cwd);
    expect(text(await grep(ctx, { pattern: "x", "-c": true, file_path: "d" }))).toContain("d/a.txt:2");
    expect(text(await grep(ctx, { pattern: "x", "-l": true, "-r": true }))).toBe("d/a.txt");
  });

  test("paths outside the working directory are absolute; a single-file path still reports counts", async () => {
    const cwd = await workspace();
    const other = await workspace();
    await files(other, { "o.txt": "x\n" });
    const ctx = await searchContext(cwd);
    expect(text(await grep(ctx, { pattern: "x", path: other }))).toBe(join(other, "o.txt"));
    expect(text(await grep(ctx, { pattern: "x", path: join(other, "o.txt"), output_mode: "count" }))).toContain(
      "o.txt:1\nTotal: 1 matches in 1 files.",
    );
  });

  test("hidden instruction characters are removed from results and taint the session", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.txt": `ok\u{E0041}\u{E0042}end\n` });
    const out = await grep(await searchContext(cwd), { pattern: "ok", output_mode: "content" });
    expect(text(out)).toContain("1:ok⟨2 hidden characters removed⟩end");
    expect(out.meta?.effects).toEqual([{ kind: "taint", source: "Grep results" }]);
  });
});

describe("Grep: ignore files and sensitive files", () => {
  // spec: AC-TOOLS-29
  test("a .gitignore is honored without a .git directory; an ignored path is searched and says so", async () => {
    const cwd = await workspace();
    await files(cwd, {
      ".gitignore": "node_modules\n",
      "src/a.ts": "needle\n",
      "node_modules/x/i.js": "needle\n",
      "node_modules/x/.gitignore": "dist\n",
      "node_modules/x/dist/a.js": "needle\n",
    });
    const ctx = await searchContext(cwd);
    expect(text(await grep(ctx, { pattern: "needle" }))).toBe("src/a.ts");
    const inside = await grep(ctx, { pattern: "needle", path: "node_modules/x" });
    expect(text(inside)).toContain("node_modules/x/i.js");
    expect(text(inside)).toContain("node_modules/x/dist/a.js");
    expect(text(inside)).toContain("Searched an ignored directory.");
    expect(text(await grep(ctx, { pattern: "needle", path: "src" }))).not.toContain("Searched an ignored");
  });

  test("VCS metadata folders are never searched", async () => {
    const cwd = await workspace();
    await files(cwd, { ".hg/store": "needle\n", ".jj/x": "needle\n", ".git/config": "needle\n", "a.txt": "needle\n" });
    expect(text(await grep(await searchContext(cwd), { pattern: "needle" }))).toBe("a.txt");
  });

  test("sensitive files are skipped and counted; a sensitive file given as path is searched", async () => {
    const cwd = await workspace();
    await files(cwd, {
      ".env": "needle\n",
      "keys/server.pem": "needle\n",
      "a.txt": "needle\n",
      "docs/.env.example": "needle\n",
    });
    const ctx = await searchContext(cwd);
    const out = await grep(ctx, { pattern: "needle" });
    expect(text(out)).toBe("a.txt\n(3 sensitive files skipped)");
    expect(text(await grep(ctx, { pattern: "zzz" }))).toBe("No matches found.\n(3 sensitive files skipped)");
    expect(text(await grep(ctx, { pattern: "needle", path: ".env" }))).toBe(".env");
  });

  test("permissions.sensitiveFiles add and remove change what is skipped", async () => {
    const cwd = await workspace();
    await files(cwd, { "a.key": "needle\n", "b.secret": "needle\n" });
    const settings = Settings.parse({
      permissions: { sensitiveFiles: { add: ["**/*.secret"], remove: ["**/*.key"] } },
    });
    const out = await grep(await searchContext(cwd, { settings }), { pattern: "needle" });
    expect(text(out)).toBe("a.key\n(1 sensitive files skipped)");
  });
});

describe("Grep: failures are never 'no matches'", () => {
  // spec: AC-TOOLS-29
  test("a search past the time limit returns the partial results with the timeout note", async () => {
    const cwd = await workspace();
    const ctx = fakeRg(await searchContext(cwd), "process.stdout.write('a.txt\\0'); setInterval(() => {}, 1000);");
    const out = await grep(ctx, { pattern: "x" }, createGrepTool({ limits: { timeoutMs: 400 } }));
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("a.txt");
    expect(text(out)).toContain("[Search stopped after 0.4 s; results are partial. Narrow path, glob or type.]");
    expect(text(out)).not.toContain("No matches found");
  });

  test("a timeout with no output so far is still not 'No matches found'", async () => {
    const cwd = await workspace();
    const ctx = fakeRg(await searchContext(cwd), "setInterval(() => {}, 1000);");
    const out = await grep(ctx, { pattern: "x" }, createGrepTool({ limits: { timeoutMs: 300 } }));
    expect(text(out)).toContain("results are partial");
    expect(text(out)).not.toContain("No matches found");
  });

  test("exit code 2 with no message is an error, not 'No matches found'", async () => {
    const cwd = await workspace();
    const out = await grep(fakeRg(await searchContext(cwd), "process.exit(2)"), { pattern: "x" });
    expect(out.status).toBe("error");
    expect(text(out)).not.toContain("No matches found");
  });

  // spec: AC-TOOLS-33
  test("ripgrep failing to spawn is an error naming the cause", async () => {
    const cwd = await workspace();
    const base = await searchContext(cwd);
    const ctx: ToolContext = {
      ...base,
      platform: {
        ...base.platform,
        spawn: () => {
          throw new Error("spawn EAGAIN: out of processes");
        },
      },
    };
    const out = await grep(ctx, { pattern: "x" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("Could not start ripgrep: spawn EAGAIN: out of processes");
  });

  // spec: AC-TOOLS-33
  test("an unreadable path is an error", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const cwd = await workspace();
    await files(cwd, { "locked/a.txt": "x\n" });
    await chmod(join(cwd, "locked"), 0o000);
    try {
      const out = await grep(await searchContext(cwd), { pattern: "x", path: "locked" });
      expect(out.status).toBe("error");
      expect(text(out)).toContain("Permission denied");
    } finally {
      await chmod(join(cwd, "locked"), 0o755);
    }
  });

  // spec: AC-TOOLS-33
  test("a missing path is reported as an error", async () => {
    const cwd = await workspace();
    const out = await grep(await searchContext(cwd), { pattern: "x", path: "nope" });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("Path not found");
  });

  test("some unreadable files inside a search add a count to the results", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const cwd = await workspace();
    await files(cwd, { "ok.txt": "x\n", "locked/a.txt": "x\n" });
    await chmod(join(cwd, "locked"), 0o000);
    try {
      const out = await grep(await searchContext(cwd), { pattern: "x" });
      expect(text(out)).toBe("ok.txt\n(1 paths couldn't be read)");
    } finally {
      await chmod(join(cwd, "locked"), 0o755);
    }
  });

  // spec: AC-TOOLS-33
  test("a run producing more than 20 MB of output stops with partial results", async () => {
    const cwd = await workspace();
    const script =
      "const line = 'f'.repeat(99) + '\\0'; const block = line.repeat(10000); for (let i = 0; i < 40; i++) process.stdout.write(block); setInterval(() => {}, 1000);";
    const out = await grep(fakeRg(await searchContext(cwd), script), { pattern: "x", head_limit: 3 });
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("[Output exceeded 20 MB; ripgrep was stopped and results are partial.");
    expect(text(out)).not.toContain("No matches found");
  });

  test("a missing bundled ripgrep falls back to PATH and says so; with none the message names apk", async () => {
    const cwd = await workspace();
    const base = await searchContext(cwd);
    await files(cwd, { "a.txt": "x\n" });
    const missing = { ...base.platform, libexec: () => join(cwd, "nope", "rg") as never };
    const viaPath = await grep(
      { ...base, platform: { ...missing, resolve: async () => base.platform.libexec("rg") } },
      { pattern: "x" },
    );
    expect(text(viaPath)).toContain("a.txt");
    expect(text(viaPath)).toContain("The bundled ripgrep is missing; used rg from PATH");
    const none = await grep({ ...base, platform: { ...missing, resolve: async () => undefined } }, { pattern: "x" });
    expect(none.status).toBe("error");
    expect(text(none)).toContain("apk add ripgrep");
  });

  test("an interrupted search reports interruption", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    controller.abort();
    const out = await grep(await searchContext(cwd, { signal: controller.signal }), { pattern: "x" });
    expect(out.status).toBe("interrupted");
  });
});
