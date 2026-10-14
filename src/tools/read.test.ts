import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformCore, type Os } from "../platform/index.ts";
import { type AbsPath, type EventEnvelope, Settings } from "../schema/index.ts";
import {
  buildReadResultsIndex,
  createReadState,
  createReadTool,
  createToolRegistry,
  type ReadResultsIndex,
  type ToolContext,
  type ToolOutput,
} from "./index.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "dovet-read-")));
  dirs.push(dir);
  return dir;
}

const noHistory: ReadResultsIndex = { lookup: () => undefined };

function context(cwd: string, over: Partial<ToolContext> = {}): ToolContext {
  const os = process.platform as Os;
  const core = createPlatformCore({
    os,
    arch: process.arch,
    execPath: process.execPath,
    env: {},
    projectRoot: cwd as AbsPath,
    kill: () => undefined,
  });
  return {
    session: {
      id: "s",
      cwd: cwd as AbsPath,
      workingDirs: [cwd as AbsPath],
      mode: "default",
      taint: [],
      interactive: false,
    },
    settings: Settings.parse({}),
    signal: new AbortController().signal,
    readState: createReadState(os),
    emit: () => undefined,
    platform: {
      ...core,
      shells: () => ({}),
      clipboard: { readImage: async () => null, writeText: async () => undefined },
    },
    readResults: noHistory,
    contextFreeTokens: 200_000,
    ...over,
  };
}

const text = (out: ToolOutput): string => out.content.map((p) => (p.kind === "text" ? p.text : "")).join("");

async function read(ctx: ToolContext, input: Record<string, unknown>, tool = createReadTool()): Promise<ToolOutput> {
  const prepared = createToolRegistry([tool]).prepare("Read", input);
  if (!prepared.ok) throw new Error(prepared.message);
  return tool.run(prepared.input as never, ctx);
}

const numbered = (count: number, width = 60): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1} ${"x".repeat(width)}`).join("\n");

describe("Read: text views", () => {
  // spec: AC-TOOLS-17
  test("lines are `<n>\\t<text>` with no padding", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), `${Array.from({ length: 12 }, (_, i) => `row${i + 1}`).join("\n")}\n`);
    const out = await read(context(cwd), { file_path: "a.txt" });
    const lines = text(out).split("\n");
    expect(out.status).toBe("ok");
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe("1\trow1");
    expect(lines[11]).toBe("12\trow12");
  });

  // spec: AC-TOOLS-17
  // spec: AC-TOOLS-01
  test("a whole-file read over the token limit returns the first page with the PARTIAL notice", async () => {
    const cwd = await workspace();
    const body = numbered(3500, 80);
    expect(body.length).toBeGreaterThan(300_000);
    await writeFile(join(cwd, "big.txt"), body);
    const ctx = context(cwd);
    const out = await read(ctx, { file_path: "big.txt" });
    const shown = text(out);
    const match =
      /\[PARTIAL view: lines 1–(\d+) of 3500 \(~(\d+) tokens total\)\. Read more with offset\/limit, search with Grep, or pass allow_large: true if you need the whole file\.\]$/.exec(
        shown,
      );
    expect(match).not.toBeNull();
    const last = Number(match?.[1]);
    expect(last).toBeGreaterThan(500);
    expect(last).toBeLessThan(3500);
    expect(shown.length).toBeLessThan(25_000 * 3.5 + 500);
    expect(ctx.readState.get(join(cwd, "big.txt"))?.partial).toBe(true);
  });

  // spec: AC-TOOLS-01
  test("a range read over the limit is cut with a continuation hint", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "big.txt"), numbered(3500, 80));
    const ctx = context(cwd, { settings: Settings.parse({ read: { maxTokens: 2000 } }) });
    const shown = text(await read(ctx, { file_path: "big.txt", offset: 100, limit: 3000 }));
    const match = /\[PARTIAL view: lines 100–(\d+) of 3500\. Continue with offset=(\d+)\.\]$/.exec(shown);
    expect(match).not.toBeNull();
    expect(Number(match?.[2])).toBe(Number(match?.[1]) + 1);
    expect(shown.startsWith("100\tline 100 ")).toBe(true);
  });

  test("a range that fits is returned without a notice; past the end and empty files say so", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "a\nb\nc\nd\n");
    await writeFile(join(cwd, "empty.txt"), "");
    const ctx = context(cwd);
    expect(text(await read(ctx, { file_path: "a.txt", offset: 2, limit: 2 }))).toBe("2\tb\n3\tc");
    expect(text(await read(ctx, { file_path: "a.txt", offset: "3", limit: "1" }))).toBe("3\tc");
    expect(text(await read(ctx, { file_path: "a.txt", offset: 9 }))).toBe(
      "[File has 4 lines; offset 9 is past the end.]",
    );
    expect(text(await read(ctx, { file_path: "empty.txt" }))).toBe("[File exists but is empty.]");
  });

  // spec: AC-TOOLS-01
  test("UTF-16LE with a BOM is decoded and remembered; a UTF-8 BOM is stripped", async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, "u16.txt"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo\r\nwörld\r\n", "utf16le")]),
    );
    await writeFile(join(cwd, "u8.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("plain\n")]));
    const ctx = context(cwd);
    expect(text(await read(ctx, { file_path: "u16.txt" }))).toBe("1\théllo\n2\twörld");
    expect(ctx.readState.get(join(cwd, "u16.txt"))).toMatchObject({
      encoding: "utf16le",
      eol: "\r\n",
      partial: false,
    });
    expect(text(await read(ctx, { file_path: "u8.txt" }))).toBe("1\tplain");
    expect(ctx.readState.get(join(cwd, "u8.txt"))?.encoding).toBe("utf8-bom");
  });

  // spec: AC-TOOLS-01
  test("invalid UTF-8 shows U+FFFD and is flagged in read-state", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "bad.txt"), Buffer.from([0x61, 0xff, 0x62, 0x0a]));
    const ctx = context(cwd);
    expect(text(await read(ctx, { file_path: "bad.txt" }))).toBe("1\ta�b");
    expect(ctx.readState.get(join(cwd, "bad.txt"))?.encoding).toBe("invalid");
  });

  test("long lines are truncated and binary files are described", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "long.txt"), `${"y".repeat(2500)}\n`);
    await writeFile(join(cwd, "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    const ctx = context(cwd);
    const shown = text(await read(ctx, { file_path: "long.txt" }));
    expect(shown).toBe(`1\t${"y".repeat(2000)}… [line truncated, 2500 chars]`);
    expect(text(await read(ctx, { file_path: "bin.dat" }))).toBe(
      "Binary file (8 bytes, image/png). Not readable as text.",
    );
  });

  // spec: AC-TOOLS-01
  test("images and PDFs are described as binary even without a NUL byte; a symlink reports both paths to the policy", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "doc.pdf"), "just text\n");
    await writeFile(join(cwd, "noext"), "%PDF-1.4\nplain text only\n");
    await writeFile(join(cwd, "real.txt"), "x\n");
    await symlink(join(cwd, "real.txt"), join(cwd, "ln"));
    const ctx = context(cwd);
    expect(text(await read(ctx, { file_path: "doc.pdf" }))).toStartWith("Binary file (");
    expect(text(await read(ctx, { file_path: "noext" }))).toContain("application/pdf");
    const action = createReadTool().describeAction({ file_path: "ln" }, ctx);
    expect(action.kind === "read" ? action.paths : []).toEqual([join(cwd, "ln"), join(cwd, "real.txt")]);
  });

  test("mixed line endings are reported as mixed", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "m.txt"), "a\r\nb\nc\r");
    const ctx = context(cwd);
    expect(text(await read(ctx, { file_path: "m.txt" }))).toBe("1\ta\n2\tb\n3\tc");
    expect(ctx.readState.get(join(cwd, "m.txt"))?.eol).toBe("mixed");
  });

  // spec: AC-PERM-26
  test("hidden tag characters are removed, the session is tainted, ZWNJ and ZWJ pass through", async () => {
    const cwd = await workspace();
    const tags = String.fromCodePoint(0xe0069, 0xe0067, 0xe006e);
    const persian = "می‌خواهم 👩‍💻";
    await writeFile(join(cwd, "README.md"), `# Title ${tags}\n${persian}\n`);
    const out = await read(context(cwd), { file_path: "README.md" });
    const shown = text(out);
    expect(shown).toContain("1\t# Title ⟨3 hidden characters removed⟩");
    expect(shown).toContain(`2\t${persian}`);
    expect(shown).toContain("still contains them");
    expect(out.meta?.effects).toEqual([{ kind: "taint", source: `Read: ${join(cwd, "README.md")}` }]);
  });
});

describe("Read: allow_large and pages", () => {
  // spec: AC-TOOLS-32
  test("allow_large returns a 60k-token file when the free context allows it, else the PARTIAL view says why", async () => {
    const cwd = await workspace();
    const body = numbered(2800, 70);
    await writeFile(join(cwd, "huge.txt"), body);
    const tokens = Math.ceil(body.length / 3.5);
    expect(tokens).toBeGreaterThan(50_000);
    const roomy = await read(context(cwd, { contextFreeTokens: 200_000 }), {
      file_path: "huge.txt",
      allow_large: true,
    });
    expect(text(roomy)).not.toContain("PARTIAL");
    expect(text(roomy).split("\n")).toHaveLength(2800);
    const tight = text(
      await read(context(cwd, { contextFreeTokens: 80_000 }), { file_path: "huge.txt", allow_large: true }),
    );
    expect(tight).toMatch(
      /\[PARTIAL view: lines 1–\d+ of 2800 .*Too large even with allow_large \(~\d+ tokens; ~80000 free\)\./,
    );
    expect(tight.length).toBeLessThan(25_000 * 3.5 + 600);
  });

  // spec: AC-TOOLS-32
  test("a page list is refused with the one-range error", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\n");
    const out = await read(context(cwd), { file_path: "a.txt", pages: "6,9,15" });
    expect(out.status).toBe("error");
    expect(text(out)).toBe("Read one page or range per call.");
  });
});

describe("Read: file types and races", () => {
  // spec: AC-TOOLS-19
  test("directories and missing files are explained", async () => {
    const cwd = await workspace();
    const ctx = context(cwd);
    const dir = await read(ctx, { file_path: "." });
    expect(dir.status).toBe("error");
    expect(text(dir)).toBe(`${cwd} is a directory. List it with Glob or ls.`);
    expect(text(await read(ctx, { file_path: "nope.txt" }))).toBe(`File not found: ${join(cwd, "nope.txt")}`);
  });

  // spec: AC-TOOLS-19
  test.skipIf(process.platform === "win32")("a FIFO is refused immediately instead of hanging", async () => {
    const cwd = await workspace();
    execFileSync("mkfifo", [join(cwd, "pipe")]);
    const started = Date.now();
    const out = await read(context(cwd), { file_path: "pipe" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.status).toBe("error");
    expect(text(out)).toBe(`${join(cwd, "pipe")} is not a regular file (FIFO); reading it could block or never end.`);
  });

  // spec: AC-TOOLS-19
  test.skipIf(process.platform !== "linux")("/proc/self/status, which reports size 0, returns content", async () => {
    const cwd = await workspace();
    const out = await read(context(cwd), { file_path: "/proc/self/status" });
    expect(out.status).toBe("ok");
    expect(text(out)).toMatch(/\n?\d+\tName:/);
  });

  // spec: AC-TOOLS-34
  test.skipIf(process.platform === "win32")("a symlink swapped between the check and the open is refused", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "safe.txt"), "safe\n");
    await writeFile(join(cwd, "secret.txt"), "secret\n");
    await symlink(join(cwd, "safe.txt"), join(cwd, "link"));
    const swapping = createReadTool({
      afterCheck: async () => {
        await rm(join(cwd, "safe.txt"));
        await symlink(join(cwd, "secret.txt"), join(cwd, "safe.txt"));
      },
    });
    const out = await read(context(cwd), { file_path: "link" }, swapping);
    expect(out.status).toBe("error");
    expect(text(out)).not.toContain("secret");
    expect(text(out)).toContain("changed while it was being opened. Try again.");
  });

  // spec: AC-TOOLS-34
  test("a path reported under a second name still reads normally", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "shot.png.txt"), "pixels\n");
    const via =
      process.platform === "win32"
        ? join(cwd, ".", "shot.png.txt")
        : join(cwd, "..", cwd.split("/").pop() ?? "", "shot.png.txt");
    expect(text(await read(context(cwd), { file_path: via }))).toBe("1\tpixels");
  });

  test("read-state is keyed by the resolved path and records size, hash and mtime", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "real.txt"), "one\ntwo\n");
    if (process.platform !== "win32") await symlink(join(cwd, "real.txt"), join(cwd, "alias.txt"));
    const ctx = context(cwd);
    await read(ctx, { file_path: process.platform === "win32" ? "real.txt" : "alias.txt" });
    const entry = ctx.readState.get(join(cwd, "real.txt"));
    expect(entry).toMatchObject({ size: 8, partial: false, encoding: "utf8", eol: "\n" });
    expect(entry?.sha256).toBe(new Bun.CryptoHasher("sha256").update("one\ntwo\n").digest("hex"));
  });
});

describe("Read: re-read deduplication", () => {
  let id = 0;
  function log(): {
    events: EventEnvelope[];
    record(call: Record<string, unknown>, output: string, epoch?: number): void;
  } {
    const events: EventEnvelope[] = [];
    const base = { v: 1 as const, session: "01J0000000000000000000000A", ts: "2026-10-14T00:00:00.000Z", core: true };
    const push = (type: string, epoch: number, turn: number, data: unknown): void => {
      id += 1;
      events.push({ ...base, id: `01J${String(id).padStart(23, "0")}`, epoch, turn, type, data });
    };
    return {
      events,
      record(call, output, epoch = 0) {
        const callId = `call_${id}`;
        const turn = events.length + 1;
        push("tool.call", epoch, turn, { callId, name: "Read", raw: call, input: call });
        push("tool.result", epoch, turn, { callId, status: "ok", output });
      },
    };
  }

  async function turn(
    cwd: string,
    events: EventEnvelope[],
    record: ReturnType<typeof log>["record"],
    input: Record<string, unknown>,
    epoch = 0,
  ): Promise<string> {
    const ctx = context(cwd, { readResults: buildReadResultsIndex(events, epoch) });
    const shown = text(await read(ctx, input));
    record(input, shown, epoch);
    return shown;
  }

  // spec: AC-TOOLS-18
  test("an unchanged re-read returns the notice; a second hit in a row returns the content", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\nbeta\n");
    const { events, record } = log();
    const first = await turn(cwd, events, record, { file_path: "a.txt" });
    expect(first).toBe("1\talpha\n2\tbeta");
    const second = await turn(cwd, events, record, { file_path: "a.txt" });
    expect(second).toMatch(
      /^File unchanged since your Read in turn \d+ \(same range\); its content is in that earlier result\.$/,
    );
    expect(await turn(cwd, events, record, { file_path: "a.txt" })).toBe(first);
    expect(await turn(cwd, events, record, { file_path: "a.txt" })).toMatch(/^File unchanged/);
  });

  // spec: AC-TOOLS-18
  test("a different range, an external edit, or the edited bytes returned again are not deduplicated", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\nbeta\n");
    const { events, record } = log();
    await turn(cwd, events, record, { file_path: "a.txt" });
    expect(await turn(cwd, events, record, { file_path: "a.txt", offset: 2 })).toBe("2\tbeta");
    await writeFile(join(cwd, "a.txt"), "alpha\nBETA\n");
    expect(await turn(cwd, events, record, { file_path: "a.txt" })).toBe("1\talpha\n2\tBETA");
    // git checkout back to the old bytes: the last Read returned different bytes, so content comes back
    await writeFile(join(cwd, "a.txt"), "alpha\nbeta\n");
    expect(await turn(cwd, events, record, { file_path: "a.txt" })).toBe("1\talpha\n2\tbeta");
  });

  // spec: AC-TOOLS-18
  test("a compaction (new epoch) or a rewind (fork without the earlier Read) brings the content back", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\n");
    const { events, record } = log();
    await turn(cwd, events, record, { file_path: "a.txt" });
    expect(await turn(cwd, events, record, { file_path: "a.txt" }, 1)).toBe("1\talpha");
    const rewound = events.slice(0, 0);
    expect(await turn(cwd, rewound, () => undefined, { file_path: "a.txt" })).toBe("1\talpha");
  });

  // spec: AC-TOOLS-18
  test("edit-then-reread returns the new content", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\n");
    const { events, record } = log();
    await turn(cwd, events, record, { file_path: "a.txt" });
    await writeFile(join(cwd, "a.txt"), "alpha edited\n");
    expect(await turn(cwd, events, record, { file_path: "a.txt" })).toBe("1\talpha edited");
    expect(await turn(cwd, events, record, { file_path: "a.txt" })).toMatch(/^File unchanged/);
  });
});
