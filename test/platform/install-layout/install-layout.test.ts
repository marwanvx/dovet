// SPIKE-2 (docs/plan/open-questions.md): the install-directory archive (architecture "Distribution"). The host's
// archive is built with the real release code, unpacked with the OS's own `tar` into a fresh directory, and the
// unpacked binary runs the ripgrep that ships beside it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  archiveName,
  buildInstallArchive,
  executableArch,
  fetchRipgrep,
  hostTarget,
  RIPGREP_PLATFORMS,
  RIPGREP_VERSION,
} from "../../../scripts/build-release.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CACHE = join(ROOT, "dist", "cache", "ripgrep");
const WINDOWS = process.platform === "win32";

let work = "";
let unpacked = "";
let probe: { exe: string; rg: string; exitCode: number; stdout: string; stderr: string };

beforeAll(async () => {
  // Real path: the probe reports its own real path, and macOS and Windows temp directories go through links.
  work = realpathSync(mkdtempSync(join(tmpdir(), "dovet-layout-")));
  const archive = await buildInstallArchive({
    target: hostTarget(),
    version: "9.9.9",
    entry: join(import.meta.dir, "layout-probe.ts"),
    outDir: work,
    cacheDir: CACHE,
  });
  unpacked = join(work, "unpacked");
  mkdirSync(unpacked);
  // A relative archive name, with `cwd`, so GNU tar on a Windows machine doesn't read `C:` as a remote host.
  const tar = Bun.spawnSync(["tar", "-xzf", join("..", archiveName("9.9.9", hostTarget().id))], { cwd: unpacked });
  expect(archive).toBe(join(work, archiveName("9.9.9", hostTarget().id)));
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  const exe = join(unpacked, "dovet", WINDOWS ? "dovet.exe" : "dovet");
  // Run from an unrelated directory: the helper must be found from the executable's own location.
  const r = Bun.spawnSync([exe], { cwd: tmpdir() });
  if (r.exitCode !== 0) throw new Error(`unpacked binary failed (${r.exitCode}): ${r.stderr.toString()}`);
  probe = JSON.parse(r.stdout.toString());
}, 300_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("install-directory archive", () => {
  test("unpacks to dovet/ holding the executable and libexec/rg", () => {
    expect(readdirSync(join(unpacked, "dovet")).sort()).toEqual([`dovet${WINDOWS ? ".exe" : ""}`, "libexec"]);
    expect(existsSync(join(unpacked, "dovet", "libexec", WINDOWS ? "rg.exe" : "rg"))).toBe(true);
  });

  test("the unpacked binary runs the bundled ripgrep and gets its version", () => {
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout).toStartWith(`ripgrep ${RIPGREP_VERSION}`);
    // Same file, compared by canonical path: Windows runners' temp paths use 8.3 short names (RUNNER~1).
    const expected = join(unpacked, "dovet", "libexec", WINDOWS ? "rg.exe" : "rg");
    expect(realpathSync.native(probe.rg)).toBe(realpathSync.native(expected));
    expect(dirname(probe.rg)).toBe(dirname(probe.exe) + (WINDOWS ? "\\libexec" : "/libexec"));
  });

  // Windows has no execute bit to keep.
  test.skipIf(WINDOWS)("the executables keep their execute bit through the archive", () => {
    expect(statSync(join(unpacked, "dovet", "dovet")).mode & 0o111).not.toBe(0);
    expect(statSync(join(unpacked, "dovet", "libexec", "rg")).mode & 0o111).not.toBe(0);
  });

  test("the archive is named for the version and platform", () => {
    expect(archiveName("1.2.3", "linux-x64-musl")).toBe("dovet-1.2.3-linux-x64-musl.tar.gz");
    expect(existsSync(join(work, archiveName("9.9.9", hostTarget().id)))).toBe(true);
  });
});

describe("ripgrep for every target", () => {
  const FORMATS = { linux: "elf", darwin: "macho", windows: "pe" } as const;
  const PLATFORMS = Object.keys(RIPGREP_PLATFORMS).map((key) => {
    const [os, arch] = key.split("-");
    return { key, format: FORMATS[os as keyof typeof FORMATS], arch: arch as "x64" | "arm64" };
  });

  test.each(PLATFORMS)(
    "$key: the pinned download verifies and is built for that OS and CPU",
    async ({ key, format, arch }) => {
      const bytes = await fetchRipgrep(key, CACHE);
      expect(executableArch(bytes)).toEqual({ format, arch });
      expect(bytes.length).toBeGreaterThan(1_000_000);
    },
    120_000,
  );

  test("a download that doesn't match its pinned SHA-256 is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dovet-rg-cache-"));
    try {
      await expect(fetchRipgrep("linux-x64", dir, { sha256: "0".repeat(64) })).rejects.toThrow(/SHA-256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("a corrupted cached copy is replaced by a fresh, verified download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dovet-rg-cache-"));
    try {
      const good = await fetchRipgrep("linux-x64", dir);
      const cached = join(dir, readdirSync(dir)[0] ?? "");
      writeFileSync(cached, "corrupted");
      expect(await fetchRipgrep("linux-x64", dir)).toEqual(good);
      expect(statSync(cached).size).toBeGreaterThan(1_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("an executable for the wrong CPU is not accepted as a target's", () => {
    // A tiny ELF header claiming x86-64 (e_machine 0x3E), and one claiming arm64 (0xB7).
    const elf = (machine: number) => {
      const b = new Uint8Array(64);
      b.set([0x7f, 0x45, 0x4c, 0x46], 0);
      b[18] = machine;
      return b;
    };
    expect(executableArch(elf(0x3e))).toEqual({ format: "elf", arch: "x64" });
    expect(executableArch(elf(0xb7))).toEqual({ format: "elf", arch: "arm64" });
    expect(() => executableArch(elf(0x08))).toThrow(/not a recognised/);
    expect(() => executableArch(new TextEncoder().encode("#!/bin/sh".padEnd(80)))).toThrow(/not a recognised/);
  });
});
