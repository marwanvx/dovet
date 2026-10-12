// `bun run release`: the install-directory archive of every target (architecture "Distribution", ADR-20).
//
//     bun scripts/build-release.ts                       # the machine's own target
//     bun scripts/build-release.ts --all                 # all eight targets (CI)
//     bun scripts/build-release.ts --target linux-x64,windows-arm64 --out dist/release
//
// Each archive unpacks to `dovet/` holding the compiled executable, `libexec/rg` and `libexec/srt/` (the
// sandbox-runtime helpers of the target's OS). A compiled Bun executable can't run a file from its embedded
// filesystem, so helpers ship beside it as real files (SPIKE-2, SPIKE-16). Signing, checksums and notices are M0-09.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import pkg from "../package.json";
import { libexecPath } from "../src/platform/index.ts";
import { SRT_HELPER_FILES, srtHelpersFor } from "../src/policy/index.ts";
import { compileDovet } from "./build.ts";

const ROOT = join(import.meta.dir, "..");

export const RIPGREP_VERSION = "15.1.0";

/**
 * ripgrep's official release archives, pinned by SHA-256 (from the `.sha256` files beside each release asset). Keys
 * are `<os>-<arch>`. Linux x64 is the static musl build, which runs on glibc and on musl. ripgrep publishes no
 * Linux arm64 musl build (see `TARGETS`).
 */
export const RIPGREP_PLATFORMS: Record<string, { asset: string; sha256: string }> = {
  "linux-x64": {
    asset: "x86_64-unknown-linux-musl.tar.gz",
    sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
  },
  "linux-arm64": {
    asset: "aarch64-unknown-linux-gnu.tar.gz",
    sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
  },
  "darwin-x64": {
    asset: "x86_64-apple-darwin.tar.gz",
    sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
  },
  "darwin-arm64": {
    asset: "aarch64-apple-darwin.tar.gz",
    sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
  },
  "windows-x64": {
    asset: "x86_64-pc-windows-msvc.zip",
    sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
  },
  "windows-arm64": {
    asset: "aarch64-pc-windows-msvc.zip",
    sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
  },
};

export type Target = {
  /** Archive suffix: `<os>-<arch>[-musl]`. */
  id: string;
  bun: Bun.Build.CompileTarget;
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  /** Key into `RIPGREP_PLATFORMS`, or null when ripgrep publishes no build for this target. */
  ripgrep: string | null;
};

export const TARGETS: readonly Target[] = [
  { id: "linux-x64", bun: "bun-linux-x64", os: "linux", arch: "x64", ripgrep: "linux-x64" },
  { id: "linux-arm64", bun: "bun-linux-arm64", os: "linux", arch: "arm64", ripgrep: "linux-arm64" },
  { id: "linux-x64-musl", bun: "bun-linux-x64-musl", os: "linux", arch: "x64", ripgrep: "linux-x64" },
  // No official ripgrep for arm64 musl, so this archive has no libexec/rg and Dovet falls back to an `rg` on PATH
  // (architecture "Distribution"; the fallback itself is built with Grep).
  { id: "linux-arm64-musl", bun: "bun-linux-arm64-musl", os: "linux", arch: "arm64", ripgrep: null },
  { id: "darwin-arm64", bun: "bun-darwin-arm64", os: "darwin", arch: "arm64", ripgrep: "darwin-arm64" },
  { id: "darwin-x64", bun: "bun-darwin-x64", os: "darwin", arch: "x64", ripgrep: "darwin-x64" },
  { id: "windows-x64", bun: "bun-windows-x64", os: "win32", arch: "x64", ripgrep: "windows-x64" },
  { id: "windows-arm64", bun: "bun-windows-arm64", os: "win32", arch: "arm64", ripgrep: "windows-arm64" },
];

/** The target of the machine running the build (musl detected by its dynamic loader). */
export function hostTarget(): Target {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const musl = os === "linux" && existsSync("/lib") && readdirSync("/lib").some((f) => f.startsWith("ld-musl-"));
  const id = `${os}-${arch}${musl ? "-musl" : ""}`;
  const target = TARGETS.find((t) => t.id === id);
  if (!target) throw new Error(`no release target for ${id}`);
  return target;
}

export function archiveName(version: string, targetId: string): string {
  return `dovet-${version}-${targetId}.tar.gz`;
}

const sha256Hex = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * The `rg` executable of one platform's pinned ripgrep release: downloaded over HTTPS, checked against the pinned
 * SHA-256 (a mismatch throws and nothing is cached), kept in `cacheDir` so repeat builds don't download again.
 * `pin` overrides the pinned checksum (tests).
 */
export async function fetchRipgrep(platform: string, cacheDir: string, pin?: { sha256: string }): Promise<Uint8Array> {
  const info = RIPGREP_PLATFORMS[platform];
  if (!info) throw new Error(`no pinned ripgrep for ${platform}`);
  const sha256 = pin?.sha256 ?? info.sha256;
  const name = `ripgrep-${RIPGREP_VERSION}-${info.asset}`;
  const cached = join(cacheDir, name);
  let archive: Uint8Array | undefined;
  if (existsSync(cached)) {
    const bytes = await Bun.file(cached).bytes();
    if (sha256Hex(bytes) === sha256) archive = bytes;
  }
  if (!archive) {
    const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`downloading ${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const got = sha256Hex(bytes);
    if (got !== sha256) throw new Error(`${name}: SHA-256 is ${got}, expected ${sha256}`);
    mkdirSync(cacheDir, { recursive: true });
    await Bun.write(cached, bytes);
    archive = bytes;
  }
  return platform.startsWith("windows-") ? fileFromZip(archive, "rg.exe") : await fileFromTarGz(archive, "rg");
}

async function fileFromTarGz(archive: Uint8Array, name: string): Promise<Uint8Array> {
  const files = await new Bun.Archive(archive).files();
  for (const [path, file] of files) if (path.split("/").at(-1) === name) return await file.bytes();
  throw new Error(`no ${name} in the ripgrep archive`);
}

/** Reads one file out of a zip through its central directory (stored or deflated entries; no zip64). */
function fileFromZip(zip: Uint8Array, name: string): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  let at = v.getUint32(eocd + 16, true);
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("corrupt zip directory");
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const entry = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (entry.split("/").at(-1) === name) {
      const data = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = zip.subarray(data, data + size);
      if (method === 0) return raw;
      if (method === 8) return new Uint8Array(inflateRawSync(raw));
      throw new Error(`zip entry ${entry} uses unsupported compression ${method}`);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`no ${name} in the zip file`);
}

/** The CPU architecture a native executable was built for, read from its ELF, Mach-O or PE header. */
export function executableArch(bytes: Uint8Array): { format: "elf" | "macho" | "pe"; arch: "x64" | "arm64" } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => {
    throw new Error("not a recognised x64 or arm64 executable");
  };
  const pick = <T extends string>(value: number, table: [number, "x64" | "arm64"][], format: T) => {
    const arch = table.find(([code]) => code === value)?.[1];
    return arch ? { format, arch } : fail();
  };
  if (bytes.length >= 64 && v.getUint32(0, false) === 0x7f454c46)
    return pick(
      v.getUint16(18, true),
      [
        [0x3e, "x64"],
        [0xb7, "arm64"],
      ],
      "elf",
    );
  if (bytes.length >= 64 && v.getUint32(0, true) === 0xfeedfacf)
    return pick(
      v.getUint32(4, true),
      [
        [0x01000007, "x64"],
        [0x0100000c, "arm64"],
      ],
      "macho",
    );
  if (bytes.length >= 64 && v.getUint16(0, false) === 0x4d5a) {
    const pe = v.getUint32(0x3c, true);
    if (v.getUint32(pe, false) === 0x50450000)
      return pick(
        v.getUint16(pe + 4, true),
        [
          [0x8664, "x64"],
          [0xaa64, "arm64"],
        ],
        "pe",
      );
  }
  return fail();
}

const FORMAT = { linux: "elf", darwin: "macho", win32: "pe" } as const;

function assertBuiltFor(what: string, bytes: Uint8Array, target: Target): void {
  const got = executableArch(bytes);
  if (got.format !== FORMAT[target.os] || got.arch !== target.arch)
    throw new Error(`${what} for ${target.id} is a ${got.format} ${got.arch} executable`);
}

const SRT_VENDOR = join(ROOT, "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor");

/**
 * sandbox-runtime's helper files for one target, from its pinned npm package: name inside `libexec/srt/` and bytes.
 * The native ones are checked against the target's OS and CPU, like the compiled executable and ripgrep.
 */
export async function sandboxHelpers(target: Target): Promise<{ name: string; bytes: Uint8Array }[]> {
  const source: Record<string, { path: string[]; native: boolean }> = {
    [SRT_HELPER_FILES.javaAgent]: { path: ["java-proxy-agent", "srt-proxy-agent.jar"], native: false },
    [SRT_HELPER_FILES.seccomp]: { path: ["seccomp", target.arch, "apply-seccomp"], native: true },
    [SRT_HELPER_FILES.srtWin]: { path: ["srt-win", target.arch, "srt-win.exe"], native: true },
  };
  return await Promise.all(
    srtHelpersFor(target.os).map(async (name) => {
      const entry = source[name];
      if (!entry) throw new Error(`no source for sandbox helper ${name}`);
      const bytes = await Bun.file(join(SRT_VENDOR, ...entry.path)).bytes();
      if (entry.native) assertBuiltFor(`sandbox helper ${name}`, bytes, target);
      return { name, bytes };
    }),
  );
}

type TarEntry = { path: string; mode: number; data?: Uint8Array };

/** A gzip-compressed ustar archive. Fixed owner and timestamp, so the same inputs give the same bytes. */
function tarGz(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const { path, mode, data } of entries) {
    const dir = data === undefined;
    const name = dir ? `${path}/` : path;
    if (enc.encode(name).length > 100) throw new Error(`tar path too long: ${name}`);
    const header = new Uint8Array(512);
    const put = (offset: number, text: string) => header.set(enc.encode(text), offset);
    put(0, name);
    put(100, `${mode.toString(8).padStart(7, "0")}\0`);
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${(data?.length ?? 0).toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, dir ? "5" : "0");
    put(257, "ustar\0");
    put(263, "00");
    const sum = header.reduce((a, b) => a + b, 0);
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header);
    if (data) {
      parts.push(data);
      parts.push(new Uint8Array((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(parts));
}

/**
 * Builds `outDir/dovet-<version>-<target>.tar.gz`: the compiled executable (`entry`, default `src/cli/main.ts`) and
 * the target's ripgrep and sandbox helpers under `libexec/`, laid out as `libexecPath` expects to find them.
 */
export async function buildInstallArchive(opts: {
  target: Target;
  version: string;
  outDir: string;
  cacheDir: string;
  entry?: string;
}): Promise<string> {
  const { target } = opts;
  const exeName = target.os === "win32" ? "dovet.exe" : "dovet";
  const scratch = mkdtempSync(join(tmpdir(), "dovet-release-"));
  try {
    const exe = join(scratch, exeName);
    await compileDovet({ outfile: exe, target: target.bun, ...(opts.entry ? { entry: opts.entry } : {}) });
    const exeBytes = await Bun.file(exe).bytes();
    assertBuiltFor("the compiled dovet", exeBytes, target);
    const entries: TarEntry[] = [
      { path: "dovet", mode: 0o755 },
      { path: `dovet/${exeName}`, mode: 0o755, data: exeBytes },
      { path: "dovet/libexec", mode: 0o755 },
    ];
    if (target.ripgrep) {
      // The path inside the archive is the one the runtime computes, relative to the executable.
      const rg = libexecPath(`dovet/${exeName}`, target.os, "rg").replaceAll("\\", "/");
      const rgBytes = await fetchRipgrep(target.ripgrep, opts.cacheDir);
      assertBuiltFor("ripgrep", rgBytes, target);
      entries.push({ path: rg, mode: 0o755, data: rgBytes });
    }
    const srtDir = libexecPath(`dovet/${exeName}`, target.os, "srt").replaceAll("\\", "/");
    entries.push({ path: srtDir, mode: 0o755 });
    for (const { name, bytes } of await sandboxHelpers(target)) {
      entries.push({ path: `${srtDir}/${name}`, mode: 0o755, data: bytes });
    }
    mkdirSync(opts.outDir, { recursive: true });
    const out = join(opts.outDir, archiveName(opts.version, target.id));
    await Bun.write(out, tarGz(entries));
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  const targets = args.includes("--all")
    ? [...TARGETS]
    : args.includes("--target")
      ? (flag("--target") ?? "").split(",").map((id) => {
          const t = TARGETS.find((x) => x.id === id);
          if (!t) throw new Error(`unknown target ${id}; known: ${TARGETS.map((x) => x.id).join(", ")}`);
          return t;
        })
      : [hostTarget()];
  const outDir = args.includes("--out") ? resolve(process.cwd(), flag("--out") ?? "") : join(ROOT, "dist", "release");
  for (const target of targets) {
    const file = await buildInstallArchive({
      target,
      version: pkg.version,
      outDir,
      cacheDir: join(ROOT, "dist", "cache", "ripgrep"),
    });
    console.log(`built ${file}${target.ripgrep ? "" : " (no ripgrep: none published for this target)"}`);
  }
}
