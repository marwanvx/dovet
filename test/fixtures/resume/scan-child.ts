// Child process of resume.test.ts: resumes a big log in a fresh process so garbage from the test's own writes can't skew the memory and time it reports.
import { resumeSession } from "../../../src/store/event-log/resume.ts";

const [data, projectRoot, session, os] = process.argv.slice(2);
if (data === undefined || projectRoot === undefined || session === undefined || os === undefined)
  throw new Error("usage: scan-child <data> <projectRoot> <session> <os>");
const loc = { data, projectRoot, session, os: os as "linux" | "darwin" | "win32" };

Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
let rssPeak = rssBefore;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > rssPeak) rssPeak = rss;
}, 5);

const t0 = Date.now();
const full = await resumeSession(loc);
const fullMs = Date.now() - t0;

const fastMs: number[] = [];
let fast = full;
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  fast = await resumeSession(loc);
  fastMs.push(Date.now() - t);
}
clearInterval(sampler);

console.log(
  JSON.stringify({
    fullMs,
    fastMs,
    rssGrowth: rssPeak - rssBefore,
    full: { readOnly: full.readOnly, fastPath: full.fastPath, lines: full.lines, epoch: full.state.epoch },
    fast: { readOnly: fast.readOnly, fastPath: fast.fastPath, lines: fast.lines, epoch: fast.state.epoch },
    sameState: Bun.deepEquals(fast.state, full.state),
  }),
);
