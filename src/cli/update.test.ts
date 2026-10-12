import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { signRelease } from "../../scripts/sign-release.ts";
import { formatSha256Sums } from "./release-signature.ts";
import { hostTargetId, installRootFor, rollback, update } from "./update.ts";

const WINDOWS = process.platform === "win32";
const OS = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const EXE = WINDOWS ? "dovet.exe" : "dovet";
const TARGET = "linux-x64";

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function newKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  return {
    privateKey: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64"),
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"),
  };
}

/** A release archive built with the system `tar` from real files, so modes survive as in a real release. */
async function archiveOf(version: string, files: Record<string, string> = {}): Promise<Uint8Array<ArrayBuffer>> {
  const src = mkdtempSync(join(work, "pack-"));
  const entries = { [EXE]: `binary ${version}`, "libexec/rg": "rg", ...files };
  for (const [name, text] of Object.entries(entries)) {
    mkdirSync(join(src, "dovet", dirname(name)), { recursive: true });
    writeFileSync(join(src, "dovet", name), text, { mode: 0o755 });
  }
  const out = join(src, "out.tar.gz");
  const tar = Bun.spawnSync(["tar", "-czf", "out.tar.gz", "dovet"], { cwd: src });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return await Bun.file(out).bytes();
}

async function writeRelease(dir: string, version: string, keys: { privateKey: string; publicKey: string }) {
  const archive = await archiveOf(version);
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, `dovet-${version}-${TARGET}.tar.gz`), archive);
  await Bun.write(
    join(dir, "SHA256SUMS"),
    formatSha256Sums([{ name: `dovet-${version}-${TARGET}.tar.gz`, sha256: sha256(archive) }]),
  );
  await signRelease(dir, keys.privateKey, [keys.publicKey]);
}

/** An install as the install script leaves it: versions/<v>/ and `current` pointing at it. */
function installVersion(root: string, version: string) {
  mkdirSync(join(root, "versions", version), { recursive: true });
  writeFileSync(join(root, "versions", version, EXE), `binary ${version}`);
  const target = join(root, "versions", version);
  symlinkSync(WINDOWS ? target : join("versions", version), join(root, "current"), "junction");
}

const current = (root: string) => basename(readlinkSync(join(root, "current")));

let work = "";
let root = "";
let releases = "";
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let keys: Awaited<ReturnType<typeof newKeys>>;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "dovet-update-"));
  releases = join(work, "releases");
  keys = await newKeys();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const file = Bun.file(join(releases, basename(new URL(req.url).pathname)));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(() => {
  root = join(work, `install-${crypto.randomUUID()}`);
  installVersion(root, "0.1.0");
  rmSync(releases, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const run = (publicKeys = [keys.publicKey]) => update({ root, baseUrl, targetId: TARGET, os: OS, publicKeys });

/** The install must look exactly as before: same version current, no other version, no leftover partial directory. */
function expectUntouched() {
  expect(current(root)).toBe("0.1.0");
  expect(readdirSync(join(root, "versions"))).toEqual(["0.1.0"]);
  expect(readdirSync(root).sort()).toEqual(["current", "versions"]);
}

describe("dovet update", () => {
  test("moves current to a newer signed release and keeps the old version", async () => {
    await writeRelease(releases, "0.2.0", keys);
    expect(await run()).toEqual({ status: "updated", from: "0.1.0", to: "0.2.0", pruneErrors: [] });
    expect(current(root)).toBe("0.2.0");
    expect(readFileSync(join(root, "current", EXE), "utf8")).toBe("binary 0.2.0");
    expect(readFileSync(join(root, "versions", "0.1.0", EXE), "utf8")).toBe("binary 0.1.0");
    expect(readFileSync(join(root, "versions", "0.2.0", "libexec", "rg"), "utf8")).toBe("rg");
    if (!WINDOWS) expect(statSync(join(root, "versions", "0.2.0", EXE)).mode & 0o111).not.toBe(0);
  });

  test("does nothing when the latest release is the installed one or older", async () => {
    await writeRelease(releases, "0.1.0", keys);
    expect(await run()).toEqual({ status: "current", version: "0.1.0" });
    rmSync(releases, { recursive: true });
    await writeRelease(releases, "0.0.9", keys);
    expect(await run()).toEqual({ status: "current", version: "0.1.0" });
    expectUntouched();
  });

  test("a second update prunes versions older than the one it replaces", async () => {
    await writeRelease(releases, "0.2.0", keys);
    await run();
    rmSync(releases, { recursive: true });
    await writeRelease(releases, "0.3.0", keys);
    await run();
    expect(readdirSync(join(root, "versions")).sort()).toEqual(["0.2.0", "0.3.0"]);
  });

  // spec: AC-ARCH-02
  test("refuses a SHA256SUMS that was changed after signing", async () => {
    await writeRelease(releases, "0.2.0", keys);
    const evil = await archiveOf("evil");
    await Bun.write(join(releases, "dovet-0.2.0-linux-x64.tar.gz"), evil);
    await Bun.write(
      join(releases, "SHA256SUMS"),
      formatSha256Sums([{ name: "dovet-0.2.0-linux-x64.tar.gz", sha256: sha256(evil) }]),
    );
    await expect(run()).rejects.toThrow(/signature does not verify/);
    expectUntouched();
  });

  // spec: AC-ARCH-02
  test("refuses a SHA256SUMS signed by a key Dovet does not trust", async () => {
    await writeRelease(releases, "0.2.0", await newKeys());
    await expect(run()).rejects.toThrow(/signature does not verify/);
    expectUntouched();
  });

  // spec: AC-ARCH-02
  test("refuses an archive whose checksum differs from the signed one", async () => {
    await writeRelease(releases, "0.2.0", keys);
    await Bun.write(join(releases, "dovet-0.2.0-linux-x64.tar.gz"), await archiveOf("evil"));
    await expect(run()).rejects.toThrow(/checksum/);
    expectUntouched();
  });

  test("refuses when no key is trusted", async () => {
    await writeRelease(releases, "0.2.0", keys);
    await expect(run([])).rejects.toThrow(/signature does not verify/);
    expectUntouched();
  });

  test("refuses a signed archive that has no executable", async () => {
    mkdirSync(releases, { recursive: true });
    const archive = await archiveOf("0.2.0", { readme: "x" }).then(async (full) => {
      const files = await new Bun.Archive(full).files();
      files.delete(`dovet/${EXE}`);
      return await new Bun.Archive(Object.fromEntries(files), { compress: "gzip" }).bytes();
    });
    await Bun.write(join(releases, "dovet-0.2.0-linux-x64.tar.gz"), archive);
    await Bun.write(
      join(releases, "SHA256SUMS"),
      formatSha256Sums([{ name: "dovet-0.2.0-linux-x64.tar.gz", sha256: sha256(archive) }]),
    );
    await signRelease(releases, keys.privateKey, [keys.publicKey]);
    await expect(run()).rejects.toThrow(new RegExp(EXE.replace(".", "\\.")));
    expectUntouched();
  });

  test("refuses a signed archive that holds files outside dovet/", async () => {
    mkdirSync(releases, { recursive: true });
    const archive = await new Bun.Archive(
      { [`dovet/${EXE}`]: "x", "elsewhere/evil": "x" },
      { compress: "gzip" },
    ).bytes();
    await Bun.write(join(releases, "dovet-0.2.0-linux-x64.tar.gz"), archive);
    await Bun.write(
      join(releases, "SHA256SUMS"),
      formatSha256Sums([{ name: "dovet-0.2.0-linux-x64.tar.gz", sha256: sha256(archive) }]),
    );
    await signRelease(releases, keys.privateKey, [keys.publicKey]);
    await expect(run()).rejects.toThrow(/outside dovet\//);
    expectUntouched();
  });

  test.skipIf(WINDOWS)("never lets a symbolic link from a signed archive into the install", async () => {
    const src = mkdtempSync(join(work, "pack-"));
    mkdirSync(join(src, "dovet"));
    writeFileSync(join(src, "dovet", EXE), "x");
    symlinkSync("/etc/passwd", join(src, "dovet", "link"));
    Bun.spawnSync(["tar", "-czf", "out.tar.gz", "dovet"], { cwd: src });
    const archive = await Bun.file(join(src, "out.tar.gz")).bytes();
    mkdirSync(releases, { recursive: true });
    await Bun.write(join(releases, "dovet-0.2.0-linux-x64.tar.gz"), archive);
    await Bun.write(
      join(releases, "SHA256SUMS"),
      formatSha256Sums([{ name: "dovet-0.2.0-linux-x64.tar.gz", sha256: sha256(archive) }]),
    );
    await signRelease(releases, keys.privateKey, [keys.publicKey]);
    // Bun's extract drops link entries; if a version ever creates them, update must refuse instead.
    const result = await run().catch((err: Error) => err);
    if (result instanceof Error) expect(result.message).toMatch(/link/);
    const links = readdirSync(join(root, "versions"), { recursive: true, withFileTypes: true }).filter((e) =>
      e.isSymbolicLink(),
    );
    expect(links).toEqual([]);
    expect(existsSync(join(root, "versions", "0.2.0", "link"))).toBe(false);
  });

  test("installs the newest version for this platform from a release listing every target", async () => {
    mkdirSync(releases, { recursive: true });
    const names: Record<string, string> = {};
    for (const [version, target] of [
      ["0.2.0", TARGET],
      ["0.3.0", TARGET],
      ["0.9.0", `${TARGET}-musl`],
      ["0.9.0", "darwin-arm64"],
      ["0.9.0", "windows-x64"],
    ] as const) {
      const archive = await archiveOf(`${version}-${target}`);
      names[`dovet-${version}-${target}.tar.gz`] = sha256(archive);
      await Bun.write(join(releases, `dovet-${version}-${target}.tar.gz`), archive);
    }
    await Bun.write(
      join(releases, "SHA256SUMS"),
      formatSha256Sums(Object.entries(names).map(([name, hash]) => ({ name, sha256: hash }))),
    );
    await signRelease(releases, keys.privateKey, [keys.publicKey]);
    expect(await run()).toMatchObject({ status: "updated", to: "0.3.0" });
    expect(readFileSync(join(root, "current", EXE), "utf8")).toBe(`binary 0.3.0-${TARGET}`);
  });

  test("orders prerelease identifiers by number, not as text", async () => {
    rmSync(root, { recursive: true });
    installVersion(root, "0.2.0-rc.9");
    await writeRelease(releases, "0.2.0-rc.10", keys);
    expect(await run()).toMatchObject({ status: "updated", from: "0.2.0-rc.9", to: "0.2.0-rc.10" });
  });

  test("reinstalls a newer version that is still on disk after a rollback", async () => {
    await writeRelease(releases, "0.2.0", keys);
    await run();
    rollback({ root, os: OS });
    expect(await run()).toMatchObject({ status: "updated", from: "0.1.0", to: "0.2.0" });
    expect(readFileSync(join(root, "current", EXE), "utf8")).toBe("binary 0.2.0");
    expect(readdirSync(join(root, "versions")).sort()).toEqual(["0.1.0", "0.2.0"]);
  });

  test("refuses a signed archive with a path that climbs out of dovet/", async () => {
    mkdirSync(releases, { recursive: true });
    const archive = await new Bun.Archive(
      { [`dovet/${EXE}`]: "x", "dovet/../../escaped": "x" },
      { compress: "gzip" },
    ).bytes();
    await Bun.write(join(releases, "dovet-0.2.0-linux-x64.tar.gz"), archive);
    await Bun.write(
      join(releases, "SHA256SUMS"),
      formatSha256Sums([{ name: "dovet-0.2.0-linux-x64.tar.gz", sha256: sha256(archive) }]),
    );
    await signRelease(releases, keys.privateKey, [keys.publicKey]);
    await run().catch((err: Error) => expect(err.message).toMatch(/outside dovet\//));
    expect(readdirSync(join(root, ".."))).not.toContain("escaped");
    expect(readdirSync(join(root, "versions")).some((n) => n.startsWith("."))).toBe(false);
  });

  test("says so when the release has no archive for this platform", async () => {
    await writeRelease(releases, "0.2.0", keys);
    await expect(
      update({ root, baseUrl, targetId: "darwin-arm64", os: OS, publicKeys: [keys.publicKey] }),
    ).rejects.toThrow(/darwin-arm64/);
    expectUntouched();
  });

  test("says so when the release server has no release", async () => {
    await expect(run()).rejects.toThrow(/SHA256SUMS/);
    expectUntouched();
  });
});

describe("dovet update --rollback", () => {
  test("returns to the version before the last update, and back again", async () => {
    await writeRelease(releases, "0.2.0", keys);
    await run();
    expect(rollback({ root, os: OS })).toEqual({ from: "0.2.0", to: "0.1.0" });
    expect(current(root)).toBe("0.1.0");
    expect(rollback({ root, os: OS })).toEqual({ from: "0.1.0", to: "0.2.0" });
    expect(current(root)).toBe("0.2.0");
  });

  test("says there is nothing to roll back to on a fresh install", () => {
    expect(() => rollback({ root, os: OS })).toThrow(/no previous version/);
    expectUntouched();
  });

  test("puts back a current that an interrupted Windows swap set aside", () => {
    renameSync(join(root, "current"), join(root, "current.old"));
    expect(() => rollback({ root, os: OS })).toThrow(/no previous version/);
    expect(current(root)).toBe("0.1.0");
  });

  test("has nothing to roll back to when previous names the running version", () => {
    writeFileSync(join(root, "previous"), "0.1.0\n");
    expect(() => rollback({ root, os: OS })).toThrow(/no previous version/);
  });

  test("refuses when the previous version's directory is gone", async () => {
    await writeRelease(releases, "0.2.0", keys);
    await run();
    rmSync(join(root, "versions", "0.1.0"), { recursive: true });
    expect(() => rollback({ root, os: OS })).toThrow(/0\.1\.0/);
    expect(current(root)).toBe("0.2.0");
  });
});

describe("installRootFor", () => {
  test("finds the install root from the real path of a versioned executable", () => {
    const sep = WINDOWS ? "\\" : "/";
    const base = join(tmpdir(), "d");
    expect(installRootFor(join(base, "versions", "0.1.0", EXE))).toBe(base);
    expect(installRootFor(join(base, "current", EXE))).toBe(base);
    expect(() => installRootFor(`${sep}opt${sep}tools${sep}${EXE}`)).toThrow(/install script/);
  });
});

describe("hostTargetId", () => {
  test("names the archive suffix of the platform", () => {
    expect(hostTargetId("darwin", "arm64", false)).toBe("darwin-arm64");
    expect(hostTargetId("win32", "x64", false)).toBe("windows-x64");
    expect(hostTargetId("linux", "arm64", true)).toBe("linux-arm64-musl");
    expect(() => hostTargetId("freebsd" as never, "x64", false)).toThrow(/freebsd/);
  });
});
