// Compiled by sdk-replay.test.ts: replays the recorded NVIDIA session inside the binary and prints the request hashes.
import session from "../../fixtures/nvidia/session.json";
import { type Fixture, replaySession, SCENARIOS } from "../../helpers/index.ts";

const s = SCENARIOS.find((x) => x.name === "session");
if (s === undefined) throw new Error("no session scenario");
const r = await replaySession(s, session as Fixture);
console.log(JSON.stringify({ sent: r.captured.map((c) => c.bodySha256), parts: r.steps.map((x) => x.stored.parts.length) }));
