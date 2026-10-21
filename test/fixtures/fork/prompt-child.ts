// Child process of fork.test.ts: opens a session, logs one user message and then sits as if a model call were running.
import { readFile } from "node:fs/promises";
import { makeUlid } from "../../../src/cli/resume-target.ts";
import { openSession, sessionPaths } from "../../../src/store/event-log/index.ts";

const [data, projectRoot, session, os, text] = process.argv.slice(2);
if (data === undefined || projectRoot === undefined || session === undefined || os === undefined || text === undefined)
  throw new Error("usage: prompt-child <data> <projectRoot> <session> <os> <text>");
const loc = { data, projectRoot, session, os: os as "linux" | "darwin" | "win32" };
const opened = await openSession({
  ...loc,
  clock: { now: () => Date.now() },
  ids: { ulid: () => makeUlid(Date.now(), crypto.getRandomValues(new Uint8Array(16))) },
  pid: process.pid,
  host: "child",
  secrets: [],
  flushMs: 600_000,
  heartbeatMs: 600_000,
});
if (opened.mode !== "write") throw new Error(opened.reason);
opened.writer.append({ type: "user.message", epoch: 0, turn: 2, data: { text } });
// The writer is never flushed here: the log must get the line without it, or this never reports ready.
const log = sessionPaths(loc).log;
for (let i = 0; i < 200; i++) {
  if ((await readFile(log, "utf8")).includes(text)) {
    console.log("READY");
    break;
  }
  await Bun.sleep(25);
}
setInterval(() => undefined, 1_000_000);
