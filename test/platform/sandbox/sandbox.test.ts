// SPIKE-16 (docs/plan/open-questions.md): sandbox-runtime inside the compiled binary. The host's install archive is
// built with the real release code and unpacked with the OS's own `tar`; the unpacked binary starts sandbox-runtime
// from `libexec/srt/` and runs commands in the sandbox.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveName, buildInstallArchive, hostTarget } from "../../../scripts/build-release.ts";
import { srtHelpersFor } from "../../../src/policy/index.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WINDOWS = process.platform === "win32";
const os = WINDOWS ? "win32" : process.platform === "darwin" ? "darwin" : "linux";

type Run = { exitCode: number; stdout: string; stderr: string };
let work = "";
let unpacked = "";
let allowed = "";
let outside = "";
let probe: {
  error?: string;
  enabled?: boolean;
  dependencies?: { errors: string[]; warnings: string[] };
  echo?: Run;
  writeAllowed?: Run;
  writeOutside?: Run;
  insideExists?: boolean;
  outsideExists?: boolean;
};

beforeAll(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "dovet-sandbox-")));
  await buildInstallArchive({
    target: hostTarget(),
    version: "9.9.9",
    entry: join(import.meta.dir, "sandbox-probe.ts"),
    outDir: work,
    cacheDir: join(ROOT, "dist", "cache", "ripgrep"),
  });
  unpacked = join(work, "unpacked");
  allowed = join(work, "allowed");
  outside = join(work, "outside");
  for (const dir of [unpacked, allowed, outside]) mkdirSync(dir);
  const tar = Bun.spawnSync(["tar", "-xzf", join("..", archiveName("9.9.9", hostTarget().id))], { cwd: unpacked });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  const exe = join(unpacked, "dovet", WINDOWS ? "dovet.exe" : "dovet");
  const r = Bun.spawnSync([exe, allowed, outside], { cwd: tmpdir() });
  if (r.exitCode !== 0) throw new Error(`unpacked binary failed (${r.exitCode}): ${r.stderr.toString()}`);
  probe = JSON.parse(r.stdout.toString());
}, 300_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("sandbox-runtime inside the compiled binary", () => {
  test("the archive holds the helper files beside the executable, in libexec/srt/", () => {
    expect(readdirSync(join(unpacked, "dovet", "libexec", "srt")).sort()).toEqual([...srtHelpersFor(os)].sort());
  });

  // The sandbox backend on native Windows needs a one-time administrator setup (permissions §7.6) that CI doesn't
  // do, so there the test records what the binary reports (see the CI log) and asserts only that it reported.
  test.skipIf(WINDOWS)("the binary starts sandbox-runtime from those files", () => {
    expect(probe.error).toBeUndefined();
    expect(probe.dependencies?.errors).toEqual([]);
    // Without the explicit seccomp path sandbox-runtime still starts, but warns "seccomp not available".
    expect(probe.dependencies?.warnings).toEqual([]);
  });

  test.skipIf(!WINDOWS)("Windows: the binary loads sandbox-runtime and reports the backend's state", () => {
    console.log(`SPIKE-16 Windows result: ${JSON.stringify(probe)}`);
    expect(probe.error !== undefined || probe.dependencies !== undefined).toBe(true);
  });

  describe.skipIf(WINDOWS)("Linux and macOS", () => {
    test("sandboxing is on and `echo hi` runs inside it", () => {
      expect(probe.enabled).toBe(true);
      expect(probe.echo?.exitCode).toBe(0);
      expect(probe.echo?.stdout.trim()).toBe("hi");
    });

    test("a write inside the allowed folder works", () => {
      expect(probe.writeAllowed?.exitCode).toBe(0);
      expect(probe.insideExists).toBe(true);
      expect(existsSync(join(allowed, "inside.txt"))).toBe(true);
    });

    test("a write outside the allowed folder is blocked", () => {
      expect(probe.writeOutside?.exitCode).not.toBe(0);
      expect(probe.outsideExists).toBe(false);
      expect(existsSync(join(outside, "outside.txt"))).toBe(false);
    });
  });
});
