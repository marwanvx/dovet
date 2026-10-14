import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolCallData } from "../schema/index.ts";
import {
  createReadState,
  createToolRegistry,
  limitOutput,
  type ReadStateEntry,
  strictSubsetViolations,
  type ToolDefinition,
  toolCallData,
  toolInputSchema,
} from "./index.ts";

function tool<I>(
  name: string,
  input: z.ZodType<I>,
  errorExample: I,
  normalize?: ToolDefinition<I>["normalize"],
): ToolDefinition<I> {
  return {
    name,
    input,
    descriptionFile: `tools/${name}.md`,
    errorExample,
    parallelSafe: true,
    mutates: "none",
    ...(normalize ? { normalize } : {}),
    describeAction: () => ({
      kind: "read",
      paths: [],
      effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
    }),
    run: () => Promise.resolve({ status: "ok", content: [] }),
  };
}

const Write = tool(
  "Write",
  z.strictObject({ file_path: z.string(), content: z.string() }),
  { file_path: "/tmp/a.txt", content: "hi" },
  {
    aliases: {
      path: "file_path",
      filePath: "file_path",
      file_text: "content",
      file_content: "content",
      text: "content",
    },
  },
);
const Read = tool(
  "Read",
  z.strictObject({
    file_path: z.string(),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  { file_path: "/tmp/a.txt" },
  { aliases: { path: "file_path" } },
);
const Bash = tool(
  "Bash",
  z.strictObject({ command: z.string(), description: z.string().optional() }),
  { command: "ls" },
  { aliases: { command_description: "description" } },
);
const registry = createToolRegistry([Write, Read, Bash]);

describe("input normalization", () => {
  // spec: AC-TOOLS-37
  test("Write with path + file_text succeeds", () => {
    const r = registry.prepare("Write", { path: "/tmp/a.txt", file_text: "hello" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input).toEqual({ file_path: "/tmp/a.txt", content: "hello" });
  });

  // spec: AC-TOOLS-37
  test("Read with offset '10' and ' +10 ' succeeds as a number", () => {
    for (const offset of ["10", " +10 "]) {
      const r = registry.prepare("Read", { file_path: "/a", offset });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input).toEqual({ file_path: "/a", offset: 10 });
    }
  });

  // spec: AC-TOOLS-37
  test("the same value under an alias and the real name collapses; different values fail", () => {
    const same = registry.prepare("Read", { path: "/a", file_path: "/a" });
    expect(same.ok).toBe(true);
    const different = registry.prepare("Read", { path: "/b", file_path: "/a" });
    expect(different.ok).toBe(false);
    if (!different.ok) expect(different.message).toContain("`path` and `file_path`");
  });

  // spec: AC-TOOLS-37
  test("raw and normalized inputs are both in the tool.call data", () => {
    const raw = { path: "/tmp/a.txt", file_text: "x" };
    const r = registry.prepare("Write", raw);
    if (!r.ok) throw new Error(r.message);
    const data = ToolCallData.parse(toolCallData("call_1", r));
    expect(data.raw).toEqual(raw);
    expect(data.input).toEqual({ file_path: "/tmp/a.txt", content: "x" });
    expect(data.name).toBe("Write");
  });

  test("null for an optional field means not given; null for a required one is an error", () => {
    const ok = registry.prepare("Read", { file_path: "/a", offset: null, limit: null });
    expect(ok.ok && ok.input).toEqual({ file_path: "/a" });
    expect(registry.prepare("Read", { file_path: null }).ok).toBe(false);
  });

  test("a stray description is dropped on non-shell tools and kept on Bash; command_description is renamed", () => {
    const read = registry.prepare("Read", { file_path: "/a", description: "why" });
    expect(read.ok && read.input).toEqual({ file_path: "/a" });
    const bash = registry.prepare("Bash", { command: "ls", command_description: "list" });
    expect(bash.ok && bash.input).toEqual({ command: "ls", description: "list" });
  });

  test("a numeric string for a string field stays a string", () => {
    const r = registry.prepare("Write", { file_path: "/a", content: "10" });
    expect(r.ok && r.input).toEqual({ file_path: "/a", content: "10" });
  });
});

describe("validation errors", () => {
  test("name the field and end with a valid example call", () => {
    const r = registry.prepare("Read", { file_path: "/a", offset: 0, bogus: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("offset");
    expect(r.message).toContain("bogus");
    expect(r.message.endsWith('Example call: {"file_path":"/tmp/a.txt"}')).toBe(true);
  });

  test("every errorExample parses with its own schema", () => {
    for (const t of registry.tools) expect(t.input.safeParse(t.errorExample).success).toBe(true);
  });

  test("a null byte in a path field is refused", () => {
    const withNul = { ...Read, pathFields: ["file_path"] };
    const r = createToolRegistry([withNul]).prepare("Read", { file_path: "/a\0b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Remove the null byte from file_path.");
  });
});

describe("tool names", () => {
  test("match case-insensitively when unambiguous", () => {
    const r = registry.prepare("bash", { command: "ls" });
    expect(r.ok && r.tool.name).toBe("Bash");
  });

  test("unknown names list the available tools", () => {
    const r = registry.prepare("Nope", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("Unknown tool Nope. Available: Bash, Read, Write");
  });

  test("two tools differing only in case: exact match wins, a third spelling is ambiguous", () => {
    const reg = createToolRegistry([tool("Foo", z.strictObject({}), {}), tool("foo", z.strictObject({}), {})]);
    expect(reg.prepare("foo", {}).ok && true).toBe(true);
    const r = reg.prepare("FOO", {});
    expect(r.ok).toBe(false);
  });
});

describe("strict subset", () => {
  test("toolInputSchema moves limits into descriptions and passes the check", () => {
    for (const t of registry.tools) expect(strictSubsetViolations(toolInputSchema(t))).toEqual([]);
    const schema = toolInputSchema(Read) as { properties: Record<string, { description?: string }> };
    expect(schema.properties.offset?.description).toContain("at least 1");
  });

  test("flags a missing additionalProperties:false, a limit keyword and a reference", () => {
    const bad = {
      type: "object",
      properties: { a: { type: "string", maxLength: 3 }, b: { type: "object", properties: {} }, c: { $ref: "#" } },
    };
    const found = strictSubsetViolations(bad).join("\n");
    expect(found).toContain("additionalProperties");
    expect(found).toContain("maxLength");
    expect(found).toContain("$ref");
  });
});

describe("output limiting", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const offloadDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "dovet-offload-"));
    dirs.push(d);
    return join(d, "outputs");
  };

  test("output at the limit is returned whole", async () => {
    const r = await limitOutput("x".repeat(30_000), { dir: await offloadDir(), id: "a" });
    expect(r.text.length).toBe(30_000);
    expect(r.offloadPath).toBeUndefined();
  });

  test("larger output keeps a 2,000-character preview and saves everything", async () => {
    const text = "line\n".repeat(10_000);
    const r = await limitOutput(text, { dir: await offloadDir(), id: "a" });
    expect(r.offloadPath).toBeDefined();
    expect(r.text.startsWith(text.slice(0, 2000))).toBe(true);
    expect(r.text).toContain(
      `[Output too long (50000 chars). Full output saved to ${r.offloadPath}. Read it with offset/limit or search it.]`,
    );
    expect(await readFile(r.offloadPath as string, "utf8")).toBe(text);
  });

  // spec: AC-TOOLS-36
  test("a 1 MB single-line JSON result is saved pretty-printed with no line over 2,000 characters", async () => {
    const json = JSON.stringify({ blob: "ab".repeat(500_000), n: [1, 2] });
    const r = await limitOutput(json, { dir: await offloadDir(), id: "j" });
    const saved = await readFile(r.offloadPath as string, "utf8");
    expect(saved.split("\n").every((l) => l.length <= 2000)).toBe(true);
    expect(saved.split("\n").length).toBeGreaterThan(500);
    expect(saved.replace(/\s/g, "").replace(/\\?"/g, "")).toContain("ab".repeat(1000));
  });

  test("long non-JSON lines are hard-wrapped without splitting a surrogate pair", async () => {
    const text = `a${"😀".repeat(40_000)}\nend`;
    const r = await limitOutput(text, { dir: await offloadDir(), id: "w" });
    const saved = await readFile(r.offloadPath as string, "utf8");
    expect(saved.replaceAll("\n", "")).toBe(text.replaceAll("\n", ""));
    expect(saved.split("\n").every((l) => l.length <= 2000)).toBe(true);
    expect(saved).not.toContain("\uFFFD");
  });

  test.skipIf(process.platform === "win32")("the offload directory and file are private", async () => {
    const dir = await offloadDir();
    const r = await limitOutput("y".repeat(40_000), { dir, id: "p" });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(r.offloadPath as string)).mode & 0o777).toBe(0o600);
  });
});

describe("read state", () => {
  const entry: ReadStateEntry = {
    sha256: "a".repeat(64),
    mtimeMs: 1,
    size: 3,
    partial: false,
    encoding: "utf8",
    eol: "lf",
  };

  test("stores and returns entries by path, and forgets them", () => {
    const s = createReadState("linux");
    s.set("/a/b", entry);
    expect(s.get("/a/b")).toEqual(entry);
    expect(s.get("/a/c")).toBeUndefined();
    s.delete("/a/b");
    expect(s.get("/a/b")).toBeUndefined();
  });

  test("is case-insensitive on Windows and macOS, not on Linux", () => {
    const win = createReadState("win32");
    win.set("C:\\Work\\A.ts", entry);
    expect(win.get("c:\\work\\a.ts")).toEqual(entry);
    const linux = createReadState("linux");
    linux.set("/Work/A.ts", entry);
    expect(linux.get("/work/a.ts")).toBeUndefined();
  });

  test("does not alias the entry it was given", () => {
    const s = createReadState("linux");
    const e = { ...entry };
    s.set("/a", e);
    e.partial = true;
    expect(s.get("/a")?.partial).toBe(false);
  });
});
