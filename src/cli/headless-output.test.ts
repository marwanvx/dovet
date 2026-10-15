// Headless input and output (tui "Headless mode", interfaces §10).
import { describe, expect, test } from "bun:test";

// spec: AC-CLI-09
describe("stdin attachment", () => {
  test("piped stdin is attached before the prompt", async () => {
    const { combineStdinAndPrompt } = await import("./headless-output.ts");
    const r = combineStdinAndPrompt({ promptArg: "why?", stdinText: "log lines", piped: true });
    if (!("prompt" in r)) throw new Error(`expected prompt, got ${JSON.stringify(r)}`);
    expect(r.prompt).toContain("why?");
    expect(r.prompt.indexOf("log lines")).toBeLessThan(r.prompt.indexOf("why?"));
    expect(r.stdinName).toBe("stdin");
  });

  test("no prompt argument reads the prompt from stdin", async () => {
    const { combineStdinAndPrompt } = await import("./headless-output.ts");
    const r = combineStdinAndPrompt({ promptArg: undefined, stdinText: "do it", piped: true });
    if (!("prompt" in r)) throw new Error(`expected prompt, got ${JSON.stringify(r)}`);
    expect(r.prompt).toContain("do it");
  });

  test("stdin over 10 MB is refused", async () => {
    const { combineStdinAndPrompt } = await import("./headless-output.ts");
    const big = "x".repeat(10 * 1024 * 1024 + 1);
    const r = combineStdinAndPrompt({ promptArg: "q", stdinText: big, piped: true });
    if (!("error" in r)) throw new Error("expected an error");
    expect(r.exitCode).toBe(2);
  });
});

// spec: AC-TUI-05
describe("headless output and exit codes", () => {
  test("json output validates against the published schema", async () => {
    const { HeadlessJson, formatJson } = await import("./headless-output.ts");
    const { readFileSync } = await import("node:fs");
    const schema = JSON.parse(readFileSync("schema/headless.schema.json", "utf8"));
    expect(schema.properties?.result).toBeDefined();
    const text = formatJson({
      result: "done",
      stopReason: "end_turn",
      incomplete: false,
      sessionId: "01K7TESTTESTTESTTESTTEST01",
      receipt: {},
      usage: {},
      cost: 0.01,
    });
    expect(HeadlessJson.safeParse(JSON.parse(text)).success).toBe(true);
  });

  test("stream-json escapes U+2028/U+2029 per line", async () => {
    const { formatStreamJson } = await import("./headless-output.ts");
    const out = formatStreamJson([{ type: "text", text: "  " }]);
    const line = out.trim().split("\n")[0] ?? "";
    expect(line).not.toContain(" ");
    expect(line).toContain("\\u2028");
    expect(JSON.parse(line)).toMatchObject({ schema: "dovet.stream/1" });
  });

  test("exit codes follow the spec table", async () => {
    const { exitCodeFor } = await import("./headless-output.ts");
    expect(exitCodeFor({ kind: "ok" })).toBe(0);
    expect(exitCodeFor({ kind: "ok", incomplete: true })).toBe(0);
    expect(exitCodeFor({ kind: "usage" })).toBe(2);
    expect(exitCodeFor({ kind: "guard" })).toBe(3);
    expect(exitCodeFor({ kind: "budget" })).toBe(4);
    expect(exitCodeFor({ kind: "refusal" })).toBe(5);
    expect(exitCodeFor({ kind: "history-rejected" })).toBe(6);
    expect(exitCodeFor({ kind: "error" })).toBe(1);
    expect(exitCodeFor({ kind: "crash" })).toBe(70);
    expect(exitCodeFor({ kind: "signal", signal: "SIGINT" })).toBe(130);
    expect(exitCodeFor({ kind: "signal", signal: "SIGHUP" })).toBe(129);
    expect(exitCodeFor({ kind: "signal", signal: "SIGTERM" })).toBe(143);
  });
});

// spec: AC-CLI-19
describe("offline output", () => {
  test("offline json still validates and names offline in the refusal", async () => {
    const { HeadlessJson } = await import("./headless-output.ts");
    const { offlineRefusal } = await import("./startup.ts");
    expect(offlineRefusal("WebFetch")).toContain("--offline");
    const sample = {
      schema: "dovet.json/1" as const,
      result: offlineRefusal("WebFetch"),
      stopReason: "end_turn",
      incomplete: false,
      sessionId: "01K7TESTTESTTESTTESTTEST02",
      receipt: {},
      usage: {},
      cost: 0,
    };
    expect(HeadlessJson.safeParse(sample).success).toBe(true);
  });

  test("stream lines validate against the stream schema", async () => {
    const { StreamJson, formatStreamJson } = await import("./headless-output.ts");
    const out = formatStreamJson([{ type: "text", text: "hi" }]);
    for (const line of out.trim().split("\n")) {
      expect(StreamJson.safeParse(JSON.parse(line)).success).toBe(true);
    }
  });

  test("published schemas match the zod sources", async () => {
    const { readFileSync } = await import("node:fs");
    const { z } = await import("zod");
    const { HeadlessJson, StreamJson } = await import("./headless-output.ts");
    const headless = JSON.stringify(
      { title: "Dovet headless JSON output", ...z.toJSONSchema(HeadlessJson, { io: "input", target: "draft-7" }) },
      null,
      2,
    );
    const stream = JSON.stringify(
      { title: "Dovet stream JSON", ...z.toJSONSchema(StreamJson, { io: "input", target: "draft-7" }) },
      null,
      2,
    );
    expect(readFileSync("schema/headless.schema.json", "utf8").trim()).toBe(headless.trim());
    expect(readFileSync("schema/stream.schema.json", "utf8").trim()).toBe(stream.trim());
  });
});
