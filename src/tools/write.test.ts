import { describe, expect, test } from "bun:test";
import { chmod, link, mkdir, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AbsPath } from "../schema/index.ts";
import { createReadTool, createToolRegistry, limitOutput, type ToolContext, type ToolOutput } from "./index.ts";
import { context, text, workspace } from "./test-context.ts";
import { createWriteTool } from "./write.ts";
import { type WriteHooks, writeBytes } from "./write-file.ts";

const readTool = createReadTool();

async function call(
  ctx: ToolContext,
  name: "Read" | "Write",
  input: Record<string, unknown>,
  hooks?: WriteHooks,
): Promise<ToolOutput> {
  const tool = name === "Read" ? readTool : createWriteTool({ hooks });
  const prepared = createToolRegistry([tool as never]).prepare(name, input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, ctx);
}
const write = (ctx: ToolContext, file_path: string, content: string, hooks?: WriteHooks) =>
  call(ctx, "Write", { file_path, content }, hooks);
const readFull = (ctx: ToolContext, file_path: string) => call(ctx, "Read", { file_path });
const lines = (n: number, tag = "line"): string =>
  `${Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n")}\n`;
const isRoot = process.getuid?.() === 0;

describe("Write: preconditions", () => {
  test("creates a new file with parents and counts its lines", async () => {
    const cwd = await workspace();
    const out = await write(context(cwd), "a/b/new.txt", "one\ntwo\n");
    expect(out.status).toBe("ok");
    expect(text(out)).toBe(`Created ${join(cwd, "a/b/new.txt")} (2 lines)`);
    expect(await readFile(join(cwd, "a/b/new.txt"), "utf8")).toBe("one\ntwo\n");
    expect(out.meta?.fileChanges).toEqual([{ path: join(cwd, "a/b/new.txt"), op: "create", added: 2, removed: 0 }]);
  });

  test("an existing file must have been read in full first", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "old\n");
    const ctx = context(cwd);
    expect(text(await write(ctx, "a.txt", "new\n"))).toContain("Read");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("old\n");
    await call(ctx, "Read", { file_path: "a.txt", limit: 1 });
    await writeFile(join(cwd, "b.txt"), "x\ny\n");
    await call(ctx, "Read", { file_path: "b.txt", limit: 1 });
    expect((await write(ctx, "b.txt", "z\n")).status).toBe("error");
  });

  test("a directory is refused", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "d"));
    expect(text(await write(context(cwd), "d", "x"))).toBe(`${join(cwd, "d")} is a directory.`);
  });

  // spec: AC-TOOLS-21
  test("refuses a file that changed after the Read, and succeeds after a fresh Read", async () => {
    const cwd = await workspace();
    const file = join(cwd, "a.txt");
    await writeFile(file, "one\n");
    const ctx = context(cwd);
    await readFull(ctx, "a.txt");
    await writeFile(file, "edited by an IDE\n");
    const refused = await write(ctx, "a.txt", "mine\n");
    expect(refused.status).toBe("error");
    expect(text(refused)).toBe(
      `${file} changed since you read it (someone else edited it). Read it again before overwriting, or use Edit.`,
    );
    expect(await readFile(file, "utf8")).toBe("edited by an IDE\n");
    await readFull(ctx, "a.txt");
    expect(text(await write(ctx, "a.txt", "mine\n"))).toBe(`Updated ${file} (+1 −1 lines)`);
    expect(await readFile(file, "utf8")).toBe("mine\n");
  });

  test("refuses U+FFFD in content when the file was read as invalid UTF-8", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "bad.txt"), Buffer.from([0x61, 0xff, 0x0a]));
    const ctx = context(cwd);
    await readFull(ctx, "bad.txt");
    const out = await write(ctx, "bad.txt", "a�\n");
    expect(out.status).toBe("error");
    expect(text(out)).toContain("U+FFFD");
  });

  // spec: AC-TOOLS-22
  test("placeholder guard: refuses a new marker over removed code, allows one already in the file", async () => {
    const cwd = await workspace();
    const ctx = context(cwd);
    await writeFile(join(cwd, "a.ts"), lines(50));
    await readFull(ctx, "a.ts");
    const refused = await write(ctx, "a.ts", "// ... rest of the code unchanged\n");
    expect(refused.status).toBe("error");
    expect(text(refused)).toBe(
      'The new content contains "// ... rest of the code unchanged" where existing code was removed. Write the complete content, or use Edit to change only the part you mean.',
    );
    expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe(lines(50));

    await writeFile(join(cwd, "b.ts"), `// ... rest of the code unchanged\n${lines(50)}`);
    await readFull(ctx, "b.ts");
    expect((await write(ctx, "b.ts", "// ... rest of the code unchanged\n")).status).toBe("ok");
  });
});

describe("Write: refusals on the file system", () => {
  // spec: AC-TOOLS-36
  test("a read-only file is refused with the read-only message", async () => {
    if (isRoot) return;
    const cwd = await workspace();
    const file = join(cwd, "ro.txt");
    await writeFile(file, "x\n");
    await chmod(file, 0o444);
    const ctx = context(cwd);
    await readFull(ctx, "ro.txt");
    const out = await write(ctx, "ro.txt", "y\n");
    expect(text(out)).toBe(
      `${file} is read-only. Version control tools such as Perforce keep files read-only until checked out; ask the user.`,
    );
    expect(await readFile(file, "utf8")).toBe("x\n");
  });

  // spec: AC-TOOLS-36
  test("an offloaded 1 MB single-line JSON result can be paged with Read offset/limit", async () => {
    const cwd = await workspace();
    const json = JSON.stringify({ items: Array.from({ length: 30_000 }, (_, i) => `item-${i}`) });
    expect(json.length).toBeGreaterThan(300_000);
    const big = JSON.stringify({ blob: "z".repeat(1_000_000), json });
    const limited = await limitOutput(big, { dir: join(cwd, "out"), id: "call_1" });
    const file = limited.offloadPath ?? "";
    expect(file).toEndWith(".json");
    const ctx = context(cwd);
    const page = text(await call(ctx, "Read", { file_path: file, offset: 3, limit: 2 }));
    expect(
      page
        .split("\n")
        .slice(0, 2)
        .map((l) => l.split("\t")[0]),
    ).toEqual(["3", "4"]);
    expect(page.length).toBeLessThan(10_000);
  });

  // spec: AC-TOOLS-05
  test("a symlinked final component is refused and the link survives", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "real.txt"), "x\n");
    await symlink(join(cwd, "real.txt"), join(cwd, "ln"));
    const out = await write(context(cwd), "ln", "y\n");
    expect(text(out)).toBe(
      `${join(cwd, "ln")} is a symlink to ${join(cwd, "real.txt")}. Write to the target path instead.`,
    );
    expect(await readFile(join(cwd, "real.txt"), "utf8")).toBe("x\n");
  });

  // spec: AC-TOOLS-05
  test("a failure mid-write leaves the old content and no temp file", async () => {
    const cwd = await workspace();
    const file = join(cwd, "a.txt");
    await writeFile(file, "old\n");
    const ctx = context(cwd);
    await readFull(ctx, "a.txt");
    const killed: WriteHooks = {
      write: async (h, data) => {
        await h.write(data.subarray(0, 2));
        throw new Error("killed");
      },
    };
    await expect(write(ctx, "a.txt", "new content\n", killed)).rejects.toThrow("killed");
    expect(await readFile(file, "utf8")).toBe("old\n");
    expect(await readdir(cwd)).toEqual(["a.txt"]);
  });

  test("a directory swapped in before the rename is refused", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "d"));
    const res = await writeBytes(join(cwd, "d", "f.txt") as AbsPath, Buffer.from("x"), {
      os: process.platform as never,
      hooks: {
        beforeRename: async () => {
          await rename(join(cwd, "d"), join(cwd, "d.old"));
          await mkdir(join(cwd, "d"));
        },
      },
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain("changed while writing");
    expect(await readdir(join(cwd, "d"))).toEqual([]);
  });
});

describe("Write: strategies", () => {
  // spec: AC-TOOLS-23
  test("a setgid file is written in place: same inode, bit kept", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const file = join(cwd, "g.txt");
    await writeFile(file, "old\n");
    await chmod(file, 0o2644);
    const before = await stat(file);
    const ctx = context(cwd);
    await readFull(ctx, "g.txt");
    const out = await write(ctx, "g.txt", "n\n");
    expect(text(out)).toContain("Written in place to keep its special mode bits.");
    const after = await stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o7777).toBe(0o2644);
    expect(await readFile(file, "utf8")).toBe("n\n");
  });

  // spec: AC-TOOLS-23
  test("a file whose rename fails with EBUSY (single-file bind mount) is written in place", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const file = join(cwd, "m.txt");
    await writeFile(file, "old\n");
    const before = await stat(file);
    const ctx = context(cwd);
    await readFull(ctx, "m.txt");
    const busy: WriteHooks = {
      rename: async () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    };
    const out = await write(ctx, "m.txt", "new\n", busy);
    expect(text(out)).toContain("Written in place to keep its mount.");
    expect((await stat(file)).ino).toBe(before.ino);
    expect(await readFile(file, "utf8")).toBe("new\n");
    expect(await readdir(cwd)).toEqual(["m.txt"]);
  });

  // spec: AC-TOOLS-23
  test("a simple file is replaced atomically: a polling reader never sees partial content", async () => {
    const cwd = await workspace();
    const file = join(cwd, "s.txt");
    const oldText = "a".repeat(3_000_000);
    const newText = "b".repeat(3_000_000);
    await writeFile(file, oldText);
    const ctx = context(cwd);
    await readFull(ctx, "s.txt");
    let done = false;
    const seen = new Set<string>();
    const poller = (async () => {
      while (!done) {
        const body = await readFile(file, "utf8");
        seen.add(body === oldText ? "old" : body === newText ? "new" : `partial:${body.length}`);
      }
    })();
    const out = await write(ctx, "s.txt", newText);
    done = true;
    await poller;
    expect(out.status).toBe("ok");
    expect([...seen].filter((s) => s.startsWith("partial"))).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(newText);
  });

  // spec: AC-TOOLS-31
  test("a hard link to a file outside the workspace is broken, not written through", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const outside = await workspace();
    const target = join(outside, "bashrc");
    await writeFile(target, "export SAFE=1\n");
    await link(target, join(cwd, "linked.txt"));
    const ctx = context(cwd);
    await readFull(ctx, "linked.txt");
    const out = await write(ctx, "linked.txt", "export OWNED=1\n");
    expect(text(out)).toContain(
      "This file had 2 hard links; Dovet wrote a new file, so the other links keep the old content.",
    );
    expect(await readFile(target, "utf8")).toBe("export SAFE=1\n");
    expect(await readFile(join(cwd, "linked.txt"), "utf8")).toBe("export OWNED=1\n");
  });

  // spec: AC-TOOLS-31
  test("a setgid hard link is replaced, never written through", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "t"), "safe\n");
    await chmod(join(outside, "t"), 0o2644);
    await link(join(outside, "t"), join(cwd, "l.txt"));
    const ctx = context(cwd);
    await readFull(ctx, "l.txt");
    expect((await write(ctx, "l.txt", "mine\n")).status).toBe("ok");
    expect(await readFile(join(outside, "t"), "utf8")).toBe("safe\n");
  });

  test("a valid file rewritten from invalid UTF-8 accepts U+FFFD afterwards", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "b.txt"), Buffer.from([0x61, 0xff, 0x0a]));
    const ctx = context(cwd);
    await readFull(ctx, "b.txt");
    expect((await write(ctx, "b.txt", "ok\n")).status).toBe("ok");
    expect((await write(ctx, "b.txt", "\uFFFD is fine\n")).status).toBe("ok");
  });

  // spec: AC-TOOLS-31
  test("with the keep-link choice approved, both names change", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    await writeFile(join(cwd, "one"), "old\n");
    await link(join(cwd, "one"), join(cwd, "two"));
    const res = await writeBytes(join(cwd, "one") as AbsPath, Buffer.from("new\n"), {
      os: process.platform as never,
      keepHardLink: true,
    });
    expect(res).toMatchObject({ ok: true });
    expect(await readFile(join(cwd, "two"), "utf8")).toBe("new\n");
  });

  // spec: AC-TOOLS-24
  test("Windows: a locked target is retried five times with backoff, then written in place", async () => {
    const cwd = await workspace();
    const file = join(cwd, "locked.txt");
    await writeFile(file, "old\n");
    const delays: number[] = [];
    let attempts = 0;
    const res = await writeBytes(file as AbsPath, Buffer.from("new\n"), {
      os: "win32",
      hooks: {
        rename: async () => {
          attempts++;
          throw Object.assign(new Error("locked"), { code: "EPERM" });
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });
    expect(attempts).toBe(6);
    expect(delays).toEqual([50, 100, 200, 400, 800]);
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.notes).toEqual(["Written in place because another program has the file open."]);
    expect(await readFile(file, "utf8")).toBe("new\n");
  });

  // spec: AC-TOOLS-24
  test("Windows: a target that stays locked in place fails with the locked message", async () => {
    const cwd = await workspace();
    let writes = 0;
    const file = join(cwd, "locked.txt");
    await writeFile(file, "old\n");
    const res = await writeBytes(file as AbsPath, Buffer.from("new\n"), {
      os: "win32",
      hooks: {
        rename: async () => {
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        },
        sleep: async () => undefined,
        write: async (h, data) => {
          if (++writes === 2) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
          await h.writeFile(data);
        },
      },
    });
    expect(res).toEqual({ ok: false, message: `${file} is locked by another program (sharing violation).` });
    expect(await readFile(file, "utf8")).toBe("old\n");
  });
});

describe("Write: encoding, line endings, mode, verification", () => {
  // spec: AC-TOOLS-38
  test("a new file in a directory of CRLF files is written with CRLF", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\r\ny\r\n");
    await writeFile(join(cwd, "b.txt"), "z\r\n");
    await write(context(cwd), "new.txt", "one\ntwo\n");
    expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("one\r\ntwo\r\n");
  });

  test("end-of-line sources in order: .editorconfig, .gitattributes, neighbours, LF", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\r\n");
    await write(context(cwd), "sub/first.txt", "p\nq\n");
    expect(await readFile(join(cwd, "sub/first.txt"), "utf8")).toBe("p\nq\n");

    await writeFile(join(cwd, ".gitattributes"), "*.md text eol=crlf\n*.sh eol=lf\n");
    await write(context(cwd), "n.md", "p\nq\n");
    expect(await readFile(join(cwd, "n.md"), "utf8")).toBe("p\r\nq\r\n");

    await writeFile(
      join(cwd, ".editorconfig"),
      "root = true\n[*]\nend_of_line = lf\n[*.{md,txt}]\nend_of_line = crlf\n",
    );
    await write(context(cwd), "n.sh", "p\nq\n");
    expect(await readFile(join(cwd, "n.sh"), "utf8")).toBe("p\nq\n");
    await write(context(cwd), "m.md", "p\nq\n");
    expect(await readFile(join(cwd, "m.md"), "utf8")).toBe("p\r\nq\r\n");
  });

  test("an existing file keeps its BOM, UTF-16 encoding and dominant line ending", async () => {
    const cwd = await workspace();
    const ctx = context(cwd);
    await writeFile(
      join(cwd, "u8.txt"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\nc\n")]),
    );
    await writeFile(join(cwd, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\nb\n", "utf16le")]));
    await readFull(ctx, "u8.txt");
    await readFull(ctx, "u16.txt");
    await write(ctx, "u8.txt", "x\ny\n");
    await write(ctx, "u16.txt", "x\ny\n");
    expect([...(await readFile(join(cwd, "u8.txt"))).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect((await readFile(join(cwd, "u8.txt"))).subarray(3).toString()).toBe("x\r\ny\r\n");
    const u16 = await readFile(join(cwd, "u16.txt"));
    expect([...u16.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(u16.subarray(2).toString("utf16le")).toBe("x\ny\n");
  });

  // spec: AC-TOOLS-38
  test("a new file's mode follows the umask", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const previous = process.umask(0o002);
    try {
      await write(context(cwd), "m.txt", "x\n");
    } finally {
      process.umask(previous);
    }
    expect((await stat(join(cwd, "m.txt"))).mode & 0o777).toBe(0o664);
  });

  test("an existing file keeps its mode", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const file = join(cwd, "run.sh");
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o755);
    const ctx = context(cwd);
    await readFull(ctx, "run.sh");
    await write(ctx, "run.sh", "#!/bin/sh\necho\n");
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  // spec: AC-TOOLS-38
  test("a short write is detected by verification and retried in place", async () => {
    const cwd = await workspace();
    let calls = 0;
    const flaky: WriteHooks = {
      write: async (h, data) => {
        calls++;
        await h.writeFile(calls === 1 ? data.subarray(0, Math.floor(data.length / 2)) : data);
      },
    };
    const out = await write(context(cwd), "short.txt", "0123456789\n".repeat(100), flaky);
    expect(out.status).toBe("ok");
    expect(calls).toBe(2);
    expect(await readFile(join(cwd, "short.txt"), "utf8")).toBe("0123456789\n".repeat(100));
  });

  // spec: AC-TOOLS-38
  test("a write that stays short is an error that names the folder type", async () => {
    const cwd = await workspace();
    const res = await writeBytes(join(cwd, "s.txt") as AbsPath, Buffer.from("0123456789"), {
      os: process.platform as never,
      hooks: { write: async (h, data) => h.writeFile(data.subarray(0, 3)) },
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain("cloud-synced");
  });

  // spec: AC-TOOLS-05
  test("the checkpoint is told the before-state while the file is still untouched, on both write paths", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "old\n");
    await writeFile(join(cwd, "g.txt"), "old\n");
    if (process.platform !== "win32") await chmod(join(cwd, "g.txt"), 0o2644);
    const recorded: Array<[string, string | null, string | null]> = [];
    const ctx = context(cwd, {
      recordWrite: async (p, before) => {
        const onDisk = await readFile(p, "utf8").catch(() => null);
        recorded.push([p, before === null ? null : Buffer.from(before).toString(), onDisk]);
      },
    });
    await readFull(ctx, "a.txt");
    await readFull(ctx, "g.txt");
    await write(ctx, "a.txt", "new\n");
    await write(ctx, "g.txt", "new\n");
    await write(ctx, "fresh.txt", "x\n");
    expect(recorded).toEqual([
      [join(cwd, "a.txt"), "old\n", "old\n"],
      [join(cwd, "g.txt"), "old\n", "old\n"],
      [join(cwd, "fresh.txt"), null, null],
    ]);
  });

  test("a file that appears while a new file is being written is not overwritten", async () => {
    const cwd = await workspace();
    const file = join(cwd, "race.txt");
    const out = await write(context(cwd), "race.txt", "mine\n", {
      beforeRename: async () => {
        await writeFile(file, "theirs\n");
      },
    });
    expect(out.status).toBe("error");
    expect(text(out)).toContain("appeared while it was being written");
    expect(await readFile(file, "utf8")).toBe("theirs\n");
    expect(await readdir(cwd)).toEqual(["race.txt"]);
  });
});
