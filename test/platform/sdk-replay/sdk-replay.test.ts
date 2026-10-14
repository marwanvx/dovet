// SPIKE-44: the adapter's replay inside a Bun-compiled binary sends the recorded requests byte for byte.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDovet } from "../../../scripts/build.ts";
import { isErrno } from "../../../src/platform/index.ts";
import type { Fixture } from "../../helpers/index.ts";

const EXE = process.platform === "win32" ? ".exe" : "";
let dir = "";
let probe = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dovet-sdk-replay-"));
  probe = join(dir, `probe${EXE}`);
  await compileDovet({ entry: join(import.meta.dir, "replay-probe.ts"), outfile: probe });
}, 120_000);

afterAll(() => {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    // Windows (often its virus scanner) can hold a just-run executable for longer than the retries; a leftover temp dir is harmless.
    if (process.platform !== "win32" || !isErrno(e, "EBUSY", "EPERM")) throw e;
    console.warn(`left ${dir} behind: ${String(e)}`);
  }
});

// spec: AC-PROV-01
test("the compiled binary replays the recorded NVIDIA session with byte-identical requests", async () => {
  const fx = (await Bun.file(join(import.meta.dir, "../../fixtures/nvidia/session.json")).json()) as Fixture;
  const r = Bun.spawnSync([probe], { timeout: 60_000 });
  if (r.exitCode !== 0) throw new Error(`probe exited ${r.exitCode}: ${r.stderr.toString()}`);
  const out = JSON.parse(r.stdout.toString()) as { sent: string[]; parts: number[] };
  const recorded = fx.exchanges.map((x) => new Bun.CryptoHasher("sha256").update(x.request.body).digest("hex"));
  expect(out.sent).toEqual(recorded);
  expect(out.parts.every((n) => n > 0)).toBe(true);
}, 60_000);
