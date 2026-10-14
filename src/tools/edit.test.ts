import { describe, expect, test } from "bun:test";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEditTool, createReadTool, createToolRegistry, type ToolContext, type ToolOutput } from "./index.ts";
import { context, text, workspace } from "./test-context.ts";

const readTool = createReadTool();
const editTool = createEditTool();

async function call(ctx: ToolContext, name: "Read" | "Edit", input: Record<string, unknown>): Promise<ToolOutput> {
  const tool = name === "Read" ? readTool : editTool;
  const prepared = createToolRegistry([tool as never]).prepare(name, input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, ctx);
}
const edit = (ctx: ToolContext, file_path: string, old_string: string, new_string: string, replace_all?: boolean) =>
  call(ctx, "Edit", { file_path, old_string, new_string, ...(replace_all === undefined ? {} : { replace_all }) });
const readFull = (ctx: ToolContext, file_path: string) => call(ctx, "Read", { file_path });
const isRoot = process.getuid?.() === 0;

async function setup(name: string, content: string | Uint8Array) {
  const cwd = await workspace();
  const file = join(cwd, name);
  await writeFile(file, content);
  const ctx = context(cwd);
  await readFull(ctx, name);
  return { cwd, file, ctx };
}

describe("Edit: errors and preconditions", () => {
  test("identical strings, empty old_string and a missing file", async () => {
    const { ctx } = await setup("a.txt", "x\n");
    expect(text(await edit(ctx, "a.txt", "x", "x"))).toBe("old_string and new_string are the same; nothing to change.");
    expect(text(await edit(ctx, "a.txt", "", "x"))).toBe("old_string is empty. Use Write to create a file.");
    expect(text(await edit(ctx, "nope.txt", "a", "b"))).toBe("File not found. Use Write to create it.");
  });

  test("an unread or partially read file is refused", async () => {
    const { cwd, ctx } = await setup("a.txt", "x\ny\n");
    await writeFile(join(cwd, "b.txt"), "x\ny\n");
    expect(text(await edit(ctx, "b.txt", "x", "z"))).toContain("You must Read");
    await call(ctx, "Read", { file_path: "b.txt", limit: 1 });
    expect((await edit(ctx, "b.txt", "x", "z")).status).toBe("error");
    expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("x\ny\n");
  });

  test("a symlink and a read-only file are refused", async () => {
    const { cwd, file, ctx } = await setup("real.txt", "x\n");
    await symlink(file, join(cwd, "ln"));
    expect(text(await edit(ctx, "ln", "x", "y"))).toBe(
      `${join(cwd, "ln")} is a symlink to ${file}. Edit the target path instead.`,
    );
    if (isRoot) return;
    await chmod(file, 0o444);
    expect(text(await edit(ctx, "real.txt", "x", "y"))).toContain("is read-only");
  });

  test("a file that isn't UTF-8 is refused with the encoding guess", async () => {
    const { file, ctx } = await setup("latin.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const out = await edit(ctx, "latin.txt", "caf", "tea");
    expect(text(out)).toBe(
      `${file} isn't valid UTF-8 (looks like Latin-1). Edit it with a shell command that preserves the encoding, or ask the user about converting it.`,
    );
    expect(await readFile(file)).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  });

  test("a UTF-16 file with a BOM round-trips", async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello\nworld\n", "utf16le")]);
    const { file, ctx } = await setup("u16.txt", bytes);
    expect((await edit(ctx, "u16.txt", "world", "there")).status).toBe("ok");
    expect(await readFile(file)).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello\nthere\n", "utf16le")]),
    );
  });

  test("a placeholder over removed code is refused", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const { file, ctx } = await setup("p.ts", `${body}\n`);
    const out = await edit(ctx, "p.ts", body, "// ... rest of the code unchanged");
    expect(out.status).toBe("error");
    expect(await readFile(file, "utf8")).toBe(`${body}\n`);
  });
});

describe("Edit: staleness", () => {
  // spec: AC-TOOLS-03
  test("a changed file with an exact unique match succeeds with the note", async () => {
    const { file, ctx } = await setup("a.txt", "alpha\nbeta\n");
    await writeFile(file, "alpha\nbeta\ngamma\n");
    const out = await edit(ctx, "a.txt", "beta", "BETA");
    expect(out.status).toBe("ok");
    expect(text(out)).toContain(
      "Note: the file had other changes since you last read it. Re-read before edits that depend on surrounding code.",
    );
    expect(await readFile(file, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  // spec: AC-TOOLS-03
  test("a changed file where old_string no longer matches says to read again", async () => {
    const { file, ctx } = await setup("a.txt", "alpha\nbeta\n");
    await writeFile(file, "alpha\nBETA\n");
    const out = await edit(ctx, "a.txt", "beta", "x");
    expect(out.status).toBe("error");
    expect(text(out)).toBe("old_string not found in the current file (it changed since you read it). Read it again.");
    expect(await readFile(file, "utf8")).toBe("alpha\nBETA\n");
  });

  test("a changed file where old_string is no longer unique is refused", async () => {
    const { file, ctx } = await setup("a.txt", "beta\n");
    await writeFile(file, "beta\nbeta\n");
    expect(text(await edit(ctx, "a.txt", "beta", "x"))).toContain("Read it again");
  });

  test("an unchanged file gets no note and a second edit works without re-reading", async () => {
    const { ctx } = await setup("a.txt", "one\ntwo\n");
    const first = await edit(ctx, "a.txt", "one", "1");
    expect(text(first)).not.toContain("Note:");
    expect((await edit(ctx, "a.txt", "two", "2")).status).toBe("ok");
  });
});

describe("Edit: exact matching", () => {
  // spec: AC-TOOLS-04
  test("a CRLF file keeps CRLF", async () => {
    const { file, ctx } = await setup("w.txt", "one\r\ntwo\r\nthree\r\n");
    const out = await edit(ctx, "w.txt", "two\nthree", "2\n3");
    expect(out.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("one\r\n2\r\n3\r\n");
  });

  // spec: AC-TOOLS-04
  test("two matches without replace_all list both lines", async () => {
    const { file, ctx } = await setup("m.txt", "a\nfoo\nb\nfoo\n");
    const out = await edit(ctx, "m.txt", "foo", "bar");
    expect(text(out)).toBe(
      "old_string matches 2 places (lines 2, 4). Include more surrounding context, or set replace_all: true.",
    );
    expect(await readFile(file, "utf8")).toBe("a\nfoo\nb\nfoo\n");
  });

  test("replace_all replaces every occurrence", async () => {
    const { file, ctx } = await setup("m.txt", "foo\nx\nfoo\n");
    const out = await edit(ctx, "m.txt", "foo", "bar", true);
    expect(text(out)).toContain("Replaced 2 occurrences");
    expect(await readFile(file, "utf8")).toBe("bar\nx\nbar\n");
  });

  test("the result shows the edited region plus three lines each side in Read format", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const { ctx } = await setup("r.txt", `${body}\n`);
    const out = await edit(ctx, "r.txt", "l10\nl11", "ten\neleven\ntwelve");
    expect(text(out).split("\n").slice(1)).toEqual([
      "7\tl7",
      "8\tl8",
      "9\tl9",
      "10\tten",
      "11\televen",
      "12\ttwelve",
      "13\tl12",
      "14\tl13",
      "15\tl14",
    ]);
    expect(text(out).split("\n")[0]).toContain("(+3 −2 lines)");
  });

  test("not found shows the closest region with a diff, and nothing when nothing is close", async () => {
    const { ctx } = await setup("c.ts", "function compute(total, items) {\n  return total + items.length;\n}\n");
    const out = await edit(ctx, "c.ts", "function compute(total, itemz) {\n  return total + items.length;\n}", "x");
    expect(text(out)).toMatch(/^old_string not found in .*c\.ts\. Closest match \(lines 1–3, \d+% similar\):\n/);
    expect(text(out)).toContain("- function compute(total, itemz) {\n+ function compute(total, items) {");
    expect(text(await edit(ctx, "c.ts", "something unrelated", "x"))).toMatch(
      /^old_string not found in [^\n]*c\.ts\.$/,
    );
  });
});

describe("Edit: looser levels", () => {
  // spec: AC-TOOLS-14
  test("a space-indented old_string matches a tab-indented file; the file keeps tabs and the result says so", async () => {
    const { file, ctx } = await setup("t.go", "func main() {\n\tif ready {\n\t\trun()\n\t}\n}\n");
    const out = await edit(
      ctx,
      "t.go",
      "    if ready {\n        run()\n    }",
      "    if ready {\n        run()\n        stop()\n    }",
    );
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("Matched ignoring indentation differences.");
    expect(await readFile(file, "utf8")).toBe("func main() {\n\tif ready {\n\t\trun()\n\t\tstop()\n\t}\n}\n");
    expect(out.meta?.fileChanges?.[0]?.match).toBe("indent");
  });

  // spec: AC-TOOLS-14
  test("an inconsistent offset fails with a closest-match diff", async () => {
    const src = "function configure(options) {\n  const merged = merge(defaults, options);\n  return merged;\n}\n";
    const { file, ctx } = await setup("i.js", src);
    const out = await edit(
      ctx,
      "i.js",
      "function configure(options) {\n    const merged = merge(defaults, options);\n return merged;\n}",
      "x",
    );
    expect(out.status).toBe("error");
    expect(text(out)).toContain("Closest match (lines 1–4");
    expect(await readFile(file, "utf8")).toBe(src);
  });

  test("relative indentation is never flattened (Python stays correct)", async () => {
    const { file, ctx } = await setup("p.py", "class A:\n    def f(self):\n        return 1\n");
    const out = await edit(ctx, "p.py", "  def f(self):\n      return 1", "  def f(self):\n      return 2");
    expect(out.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("class A:\n    def f(self):\n        return 2\n");
  });

  // spec: AC-TOOLS-15
  test("an exact match wins even when a looser level would match elsewhere", async () => {
    const { file, ctx } = await setup("e.txt", "    foo()\nfoo()\n");
    const out = await edit(ctx, "e.txt", "foo()", "bar()");
    expect(text(out)).toContain("matches 2 places");
    const second = await edit(ctx, "e.txt", "\nfoo()", "\nbar()");
    expect(second.status).toBe("ok");
    expect(second.meta?.fileChanges?.[0]?.match).toBe("exact");
    expect(await readFile(file, "utf8")).toBe("    foo()\nbar()\n");
  });

  // spec: AC-TOOLS-15
  test("lines the model didn't change keep curly quotes and trailing spaces byte for byte", async () => {
    const src = "  const a = “x”;   \n  const b = 1;\n  const c = ‘y’;\t\n";
    const { file, ctx } = await setup("q.ts", src);
    const out = await edit(
      ctx,
      "q.ts",
      "const a = “x”;\nconst b = 1;\nconst c = ‘y’;",
      "const a = “x”;\nconst b = 2;\nconst c = ‘y’;",
    );
    expect(out.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("  const a = “x”;   \n  const b = 2;\n  const c = ‘y’;\t\n");
  });

  test("a looser level that finds two places lists them and edits nothing", async () => {
    const src = "  go()\nx\n    go()\n";
    const { file, ctx } = await setup("d.txt", src);
    const out = await edit(ctx, "d.txt", "\tgo()\n", "stop()\n");
    expect(text(out)).toContain("matches 2 places (lines 1, 3)");
    expect(await readFile(file, "utf8")).toBe(src);
  });

  // spec: AC-TOOLS-16
  test("old_string copied with Read's line-number prefixes matches via L1", async () => {
    const { file, ctx } = await setup("n.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const shown = text(await readFull(ctx, "n.ts"))
      .split("\n")
      .slice(0, 2)
      .join("\n");
    expect(shown).toStartWith("1\tconst a");
    const out = await edit(ctx, "n.ts", shown, "2\tconst a = 10;\n3\tconst b = 20;");
    expect(out.status).toBe("ok");
    expect(text(out)).toContain("Matched after removing the line-number prefixes.");
    expect(out.meta?.fileChanges?.[0]?.match).toBe("prefix-strip");
    expect(await readFile(file, "utf8")).toBe("const a = 10;\nconst b = 20;\nconst c = 3;\n");
  });

  test("a file that really contains numbered lines matches exactly, not via L1", async () => {
    const { ctx } = await setup("tsv.txt", "1\tone\n2\ttwo\n");
    const out = await edit(ctx, "tsv.txt", "1\tone", "1\tuno");
    expect(out.meta?.fileChanges?.[0]?.match).toBe("exact");
  });
});
