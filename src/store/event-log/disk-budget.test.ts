// The disk-write budget (event-log "Writer rules" 7): a 50-turn session stays small and only appends.
import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fakeClock, sequentialIds, type TempProject, tempProject } from "../../../test/helpers/index.ts";
import type { Os } from "../../platform/index.ts";
import { openSession } from "./index.ts";

const OS: Os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const BUDGET_BYTES = 20 * 1024 * 1024;
const TURNS = 50;

let dir: TempProject | undefined;
afterEach(async () => {
  await dir?.dispose();
  dir = undefined;
});

async function files(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.set(join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name)));
  }
  return out;
}

// spec: AC-LOG-03
test("a scripted 50-turn session writes under 20 MB and rewrites no file in place except the sidecar", async () => {
  dir = await tempProject({ "proj/README.md": "x" });
  const data = join(dir.root, "data");
  const r = await openSession({
    data,
    projectRoot: join(dir.root, "proj"),
    os: OS,
    session: "01J0000000000000000000000B",
    clock: fakeClock(Date.UTC(2026, 9, 21)),
    ids: sequentialIds("1"),
    pid: 1,
    host: "h",
    secrets: [],
  });
  if (r.mode !== "write") throw new Error(r.reason);
  const w = r.writer;
  w.append({ type: "session.start", epoch: 0, turn: null, data: { cwd: "/p" } });
  w.append({
    type: "epoch.start",
    epoch: 0,
    turn: null,
    data: { system: "s".repeat(20_000), tools: "t".repeat(10_000) },
  });

  let previous = new Map<string, Buffer>();
  for (let turn = 1; turn <= TURNS; turn++) {
    w.append({ type: "user.message", epoch: 0, turn, data: { text: `turn ${turn}: please change things` } });
    w.append({ type: "model.request", epoch: 0, turn, data: { body: "r".repeat(2_000) } });
    w.append({
      type: "model.response",
      epoch: 0,
      turn,
      data: { parts: "p".repeat(4_000), usage: { in: turn * 900, out: 300 } },
    });
    // A Write of a new 300 KB file every fifth turn goes to the blob store; the rest of the call stays in the log.
    const content = turn % 5 === 0 ? `${turn}`.repeat((300 * 1024) / `${turn}`.length) : "small";
    w.append({
      type: "tool.call",
      epoch: 0,
      turn,
      data: { name: "Write", input: { file_path: `/p/f${turn}.txt`, content } },
    });
    w.append({ type: "tool.result", epoch: 0, turn, data: { status: "ok", output: "o".repeat(30_000) } });
    w.append({
      type: "file.change",
      epoch: 0,
      turn,
      data: { path: `/p/f${turn}.txt`, op: "create", added: 1, removed: 0 },
    });
    w.append({ type: "receipt", epoch: 0, turn, data: { turn, lines: ["wrote a file"] } });
    w.append({ type: "turn.end", epoch: 0, turn, data: { reason: "end_turn" } });
    await w.flush();

    const now = await files(data);
    for (const [path, before] of previous) {
      if (path.endsWith(".meta.json") || path.endsWith(".lock")) continue;
      const after = now.get(path);
      expect(after, `${path} disappeared`).toBeDefined();
      expect(after?.subarray(0, before.length).equals(before), `${path} was rewritten in place`).toBe(true);
    }
    previous = now;
  }
  await w.close();

  let total = 0;
  for (const [, bytes] of await files(data)) total += bytes.length;
  expect(total).toBeLessThan(BUDGET_BYTES);
  expect((await stat(join(data, "blobs"))).isDirectory()).toBe(true);
  expect(total).toBeGreaterThan(TURNS * 36_000);
});
