// A string over the 256 KB blob threshold anywhere in an event: the run goes on, the log keeps a blob reference and
// replay reads the full text back (event-log "Writer rules" 5; found by the M2-16 kill -9 probe, FOLLOWUPS F29).
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSession, sessionPaths } from "../../src/store/index.ts";
import { tempProject } from "../helpers/index.ts";
import { runIn, scripted, testOs } from "./harness.ts";

const BIG = 300 * 1024;
const big = (tag: string) => `${tag} ${"x".repeat(BIG)} ${"\u{1F600}".repeat(4)} end`;

// spec: AC-LOG-07
test("a 300 KB prompt, Write content and model text are moved to blobs and the run and its resume go on", async () => {
  const dir = await tempProject({ ".dovet/settings.json": JSON.stringify({ checkpoints: { enabled: false } }) });
  try {
    const prompt = big("prompt");
    const content = big("content");
    const answer = big("answer");
    const target = join(dir.root, "big.txt");
    const out = await runIn(dir.root, {
      adapter: scripted([[{ name: "Write", input: { file_path: target, content } }], []], undefined, 0, answer),
      mode: "acceptEdits",
      prompt,
      contextWindow: 1_000_000,
    });
    expect(out.exit).toEqual({ kind: "ok" });
    expect(await readFile(target, "utf8")).toBe(content);
    const loc = { data: join(dir.root, "data"), projectRoot: dir.root, os: testOs(), session: out.sessionId };
    const log = await readFile(sessionPaths(loc).log, "utf8");
    expect(log).not.toContain("x".repeat(BIG));
    expect(log.match(/"\$blob"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const read = await readSession(loc);
    expect(read.readOnly).toBeUndefined();
    const text = JSON.stringify(read.events.map((e) => e.data));
    for (const s of [prompt, content, answer]) expect(text).toContain(JSON.stringify(s).slice(1, -1));

    const resumed = await runIn(dir.root, {
      adapter: scripted([[]]),
      resume: out.sessionId,
      prompt: "again",
      ids: "R",
      contextWindow: 1_000_000,
    });
    expect(resumed.exit).toEqual({ kind: "ok" });
  } finally {
    await dir.dispose();
  }
});
