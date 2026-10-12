import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { signRelease } from "../../../scripts/sign-release.ts";
import { formatSha256Sums, RELEASE_PUBLIC_KEYS } from "../../../src/cli/release-signature.ts";
import { detectMusl, hostTargetId, installRootFor, update } from "../../../src/cli/update.ts";

const WINDOWS = process.platform === "win32";
const OS = WINDOWS ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const EXE = WINDOWS ? "dovet.exe" : "dovet";
const TARGET = hostTargetId(OS, process.arch, detectMusl());
const INSTALL_DIR = join(import.meta.dir, "../../../install");
const SH = Bun.which("sh") ?? "sh";
const POSIX_SCRIPT = join(INSTALL_DIR, "install.sh");
const WINDOWS_SCRIPT = join(INSTALL_DIR, "install.ps1");

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

let work = "";
let releases = "";
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let keys: Awaited<ReturnType<typeof newKeys>>;

/** The signed latest release in `releases` (one version, as on GitHub), packed with the system `tar` as `build-release.ts` lays it out. */
async function writeRelease(
  version: string,
  opts: { target?: string; prepare?: (src: string) => void; tarArgs?: string[] } = {},
) {
  rmSync(releases, { recursive: true, force: true });
  mkdirSync(releases, { recursive: true });
  const src = mkdtempSync(join(work, "pack-"));
  mkdirSync(join(src, "dovet", "libexec"), { recursive: true });
  writeFileSync(join(src, "dovet", EXE), `#!/bin/sh\necho "dovet ${version}"\n`, { mode: 0o755 });
  writeFileSync(join(src, "dovet", "libexec", "rg"), "rg", { mode: 0o755 });
  writeFileSync(join(src, "dovet", "THIRD_PARTY_NOTICES"), "notices");
  opts.prepare?.(src);
  const name = `dovet-${version}-${opts.target ?? TARGET}.tar.gz`;
  const tar = Bun.spawnSync(["tar", "-czf", join(releases, name), ...(opts.tarArgs ?? ["dovet"])], { cwd: src });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  rmSync(src, { recursive: true, force: true });
  await signedSums([name]);
}

async function signedSums(names: string[]) {
  const entries = await Promise.all(
    names.map(async (name) => ({ name, sha256: sha256(await Bun.file(join(releases, name)).bytes()) })),
  );
  await Bun.write(join(releases, "SHA256SUMS"), formatSha256Sums(entries));
  await signRelease(releases, keys.privateKey, [keys.publicKey]);
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "dovet-install-"));
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
  rmSync(releases, { recursive: true, force: true });
  mkdirSync(releases, { recursive: true });
});

type Run = { code: number; out: string };

// Async: the release server runs in this process, so a blocking spawn would starve it.
async function runPosix(home: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  const bin = join(home, ".local", "bin");
  const path = (process.env.PATH ?? "").split(":").filter((p) => p !== bin);
  const r = Bun.spawn([SH, POSIX_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: home,
    env: {
      PATH: path.join(":"),
      HOME: home,
      DOVET_BASE_URL: baseUrl,
      DOVET_RELEASE_PUBLIC_KEYS: keys.publicKey,
      ...extraEnv,
    },
  });
  return finish(r);
}

async function finish(r: {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}): Promise<Run> {
  const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
  return { code, out: `${out}${err}` };
}

const posixHome = () => mkdtempSync(join(work, "home-"));
const rcFiles = [".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".config/fish/config.fish"];

describe.skipIf(WINDOWS)("install.sh", () => {
  // spec: AC-CLI-07
  test("installs a signed release: versions/<v>, current symlink, ~/.local/bin/dovet, and no shell rc file is touched", async () => {
    await writeRelease("0.1.0");
    const home = posixHome();
    for (const rc of rcFiles) {
      mkdirSync(dirname(join(home, rc)), { recursive: true });
      writeFileSync(join(home, rc), `# ${rc}\n`);
    }
    const before = rcFiles.map((rc) => readFileSync(join(home, rc), "utf8"));
    const listing = () =>
      readdirSync(home, { recursive: true })
        .map(String)
        .filter((f) => !f.startsWith(".local"))
        .sort();
    const listed = listing();

    const r = await runPosix(home);
    expect(r.out).toContain("0.1.0");
    expect(r.code).toBe(0);

    const root = join(home, ".local", "share", "dovet");
    expect(readlinkSync(join(root, "current"))).toBe(join("versions", "0.1.0"));
    expect(readFileSync(join(root, "versions", "0.1.0", "libexec", "rg"), "utf8")).toBe("rg");
    expect(readlinkSync(join(home, ".local", "bin", "dovet"))).toBe(join(root, "current", "dovet"));
    expect(installRootFor(realpathSync(join(home, ".local", "bin", "dovet")))).toBe(realpathSync(root));
    const run = Bun.spawnSync([join(home, ".local", "bin", "dovet")]);
    expect(run.stdout.toString().trim()).toBe("dovet 0.1.0");

    expect(rcFiles.map((rc) => readFileSync(join(home, rc), "utf8"))).toEqual(before);
    expect(listing()).toEqual(listed);
  });

  // spec: AC-CLI-07
  test("prints the PATH line when ~/.local/bin is not on PATH, and says nothing about it when it is", async () => {
    await writeRelease("0.1.0");
    const missing = await runPosix(posixHome());
    expect(missing.out).toContain('export PATH="$HOME/.local/bin:$PATH"');

    const home = posixHome();
    const onPath = await runPosix(home, { PATH: `${join(home, ".local", "bin")}:${process.env.PATH ?? ""}` });
    expect(onPath.code).toBe(0);
    expect(onPath.out).not.toContain("export PATH");
  });

  test("installing again over the same version, and then a newer one, leaves current on the newest", async () => {
    await writeRelease("0.1.0");
    const home = posixHome();
    expect((await runPosix(home)).code).toBe(0);
    expect((await runPosix(home)).code).toBe(0);
    await writeRelease("0.2.0");
    expect((await runPosix(home)).code).toBe(0);
    const root = join(home, ".local", "share", "dovet");
    expect(basename(readlinkSync(join(root, "current")))).toBe("0.2.0");
  });

  // spec: AC-ARCH-02
  test("refuses a SHA256SUMS that was changed after signing, and installs nothing", async () => {
    await writeRelease("0.1.0");
    const sums = readFileSync(join(releases, "SHA256SUMS"), "utf8");
    writeFileSync(
      join(releases, "SHA256SUMS"),
      sums.replace(/^./, (c) => (c === "0" ? "1" : "0")),
    );
    const home = posixHome();
    const r = await runPosix(home);
    expect(r.code).not.toBe(0);
    expect(r.out.toLowerCase()).toContain("signature");
    expect(existsSync(join(home, ".local", "share", "dovet", "current"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "dovet"))).toBe(false);
  });

  // spec: AC-ARCH-02
  test("refuses an archive that does not match the signed checksum, and a signature from an untrusted key", async () => {
    await writeRelease("0.1.0");
    const archive = join(releases, `dovet-0.1.0-${TARGET}.tar.gz`);
    const original = readFileSync(archive);
    writeFileSync(archive, Buffer.concat([original, Buffer.from("x")]));
    const home = posixHome();
    const tampered = await runPosix(home);
    expect(tampered.code).not.toBe(0);
    expect(tampered.out.toLowerCase()).toContain("checksum");
    expect(existsSync(join(home, ".local", "share", "dovet", "current"))).toBe(false);

    writeFileSync(archive, original);
    const other = await newKeys();
    const untrusted = await runPosix(home, { DOVET_RELEASE_PUBLIC_KEYS: other.publicKey });
    expect(untrusted.code).not.toBe(0);
    expect(untrusted.out.toLowerCase()).toContain("signature");
    expect(existsSync(join(home, ".local", "bin", "dovet"))).toBe(false);
  });

  test("records the version it left in `previous`", async () => {
    await writeRelease("0.1.0");
    const home = posixHome();
    expect((await runPosix(home)).code).toBe(0);
    await writeRelease("0.2.0");
    expect((await runPosix(home)).code).toBe(0);
    expect(readFileSync(join(home, ".local", "share", "dovet", "previous"), "utf8").trim()).toBe("0.1.0");
  });

  // spec: AC-ARCH-02
  test("a refused release leaves an existing install exactly as it was", async () => {
    await writeRelease("0.1.0");
    const home = posixHome();
    expect((await runPosix(home)).code).toBe(0);
    const root = join(home, ".local", "share", "dovet");
    await writeRelease("0.2.0");
    const sums = readFileSync(join(releases, "SHA256SUMS"), "utf8");
    writeFileSync(
      join(releases, "SHA256SUMS"),
      sums.replace(/^./, (c) => (c === "0" ? "1" : "0")),
    );
    expect((await runPosix(home)).code).not.toBe(0);
    expect(readdirSync(join(root, "versions"))).toEqual(["0.1.0"]);
    expect(basename(readlinkSync(join(root, "current")))).toBe("0.1.0");
    expect(
      Bun.spawnSync([join(home, ".local", "bin", "dovet")])
        .stdout.toString()
        .trim(),
    ).toBe("dovet 0.1.0");
  });

  test("stops before changing anything when ~/.local/bin/dovet is a file that is not ours", async () => {
    await writeRelease("0.1.0");
    const home = posixHome();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "dovet"), "someone else's");
    const r = await runPosix(home);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("is not a link");
    expect(existsSync(join(home, ".local", "share", "dovet", "current"))).toBe(false);
    expect(readFileSync(join(home, ".local", "bin", "dovet"), "utf8")).toBe("someone else's");
  });

  test.skipIf(RELEASE_PUBLIC_KEYS.length > 0)("refuses to install while no release key is embedded", async () => {
    await writeRelease("0.1.0");
    const home = posixHome();
    const r = await runPosix(home, { DOVET_RELEASE_PUBLIC_KEYS: "" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no release key");
    expect(existsSync(join(home, ".local", "share", "dovet", "current"))).toBe(false);
  });

  // The script also tries Homebrew's openssl@3 by absolute path, which a stub on PATH can't shadow.
  const homebrewOpenssl = ["/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"].some(
    existsSync,
  );
  test.skipIf(homebrewOpenssl)("stops and names what to install when the openssl command is unusable", async () => {
    await writeRelease("0.1.0");
    const stub = mkdtempSync(join(work, "stub-"));
    writeFileSync(join(stub, "openssl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const home = posixHome();
    const r = await runPosix(home, { PATH: `${stub}:${process.env.PATH ?? ""}` });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("OpenSSL 3");
    expect(existsSync(join(home, ".local", "bin", "dovet"))).toBe(false);
  });

  // spec: AC-ARCH-02
  test("refuses a signed archive that holds a link, or a path climbing out of dovet/", async () => {
    const home = posixHome();
    await writeRelease("0.1.0", {
      prepare: (src) => symlinkSync("/etc/passwd", join(src, "dovet", "libexec", "link")),
    });
    const link = await runPosix(home);
    expect(link.code).not.toBe(0);
    expect(link.out).toContain("link");

    await writeRelease("0.1.0", {
      prepare: (src) => writeFileSync(join(src, "escape"), "x"),
      tarArgs: ["-P", "dovet", "dovet/../escape"],
    });
    const climb = await runPosix(home);
    expect(climb.code).not.toBe(0);
    expect(climb.out).toContain("outside dovet/");
    expect(existsSync(join(home, ".local", "share", "dovet", "current"))).toBe(false);
  });

  test("refuses a signed release that names two archives for this platform", async () => {
    await writeRelease("0.1.0");
    copyFileSync(join(releases, `dovet-0.1.0-${TARGET}.tar.gz`), join(releases, `dovet-0.2.0-${TARGET}.tar.gz`));
    await signedSums([`dovet-0.1.0-${TARGET}.tar.gz`, `dovet-0.2.0-${TARGET}.tar.gz`]);
    const r = await runPosix(posixHome());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("more than one archive");
  });

  test("tells Alpine arm64 users to install ripgrep, since that archive bundles none", async () => {
    await writeRelease("0.1.0", { target: "linux-arm64-musl" });
    // Only the tools the script uses, so a developer's own rg isn't found.
    const tools = mkdtempSync(join(work, "tools-"));
    for (const name of "uname mktemp rm mkdir mv ln cat cut tr grep awk tar sha256sum shasum basename readlink wc curl openssl sysctl gzip".split(
      " ",
    )) {
      const found = Bun.which(name);
      if (found) symlinkSync(found, join(tools, name));
    }
    const r = await runPosix(posixHome(), { DOVET_TARGET: "linux-arm64-musl", PATH: tools });
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("apk add ripgrep");
  });

  test("leaves an install that `dovet update` accepts: the update moves current and keeps the old version", async () => {
    await writeRelease("0.1.0");
    const home = posixHome();
    expect((await runPosix(home)).code).toBe(0);
    await writeRelease("0.2.0");
    const root = join(home, ".local", "share", "dovet");
    const result = await update({ root, baseUrl, targetId: TARGET, os: OS, publicKeys: [keys.publicKey] });
    expect(result).toMatchObject({ status: "updated", from: "0.1.0", to: "0.2.0" });
    expect(
      Bun.spawnSync([join(home, ".local", "bin", "dovet")])
        .stdout.toString()
        .trim(),
    ).toBe("dovet 0.2.0");
  });
});

const POWERSHELL = "powershell.exe";

async function runWindows(root: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  const r = Bun.spawn(
    [
      POWERSHELL,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `iex (Get-Content -Raw -Encoding UTF8 '${WINDOWS_SCRIPT}')`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DOVET_INSTALL_DIR: root,
        DOVET_BASE_URL: baseUrl,
        DOVET_RELEASE_PUBLIC_KEYS: keys.publicKey,
        DOVET_NONINTERACTIVE: "1",
        ...extraEnv,
      },
    },
  );
  return finish(r);
}

const REGISTRY = {
  User: "[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  Machine:
    "[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')",
};

/** The unexpanded Path value, as stored. */
function registryPath(scope: "User" | "Machine"): string {
  const r = Bun.spawnSync([
    POWERSHELL,
    "-NoProfile",
    "-Command",
    `[Console]::Out.Write(${REGISTRY[scope]}.GetValue('Path', '', 'DoNotExpandEnvironmentNames'))`,
  ]);
  return r.stdout.toString();
}

function setUserPath(value: string) {
  Bun.spawnSync(
    [
      POWERSHELL,
      "-NoProfile",
      "-Command",
      "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.SetValue('Path', $env:DOVET_TEST_PATH, 'ExpandString')",
    ],
    { env: { ...process.env, DOVET_TEST_PATH: value } },
  );
}

describe.skipIf(!WINDOWS)("install.ps1", () => {
  const originalUserPath = WINDOWS ? registryPath("User") : "";
  afterAll(() => {
    if (WINDOWS) setUserPath(originalUserPath);
  });

  // spec: AC-CLI-07
  test("installs a signed release behind a junction and changes only the user PATH, once", async () => {
    await writeRelease("0.1.0");
    const root = join(work, `win-${crypto.randomUUID()}`, "dovet");
    const machineBefore = registryPath("Machine");
    const userBefore = registryPath("User");

    const first = await runWindows(root);
    expect(first.out).toContain(join(root, "current"));
    expect(first).toMatchObject({ code: 0 });
    expect(readFileSync(join(root, "versions", "0.1.0", "libexec", "rg"), "utf8")).toBe("rg");
    expect(realpathSync(join(root, "current"))).toBe(realpathSync(join(root, "versions", "0.1.0")));
    expect(installRootFor(realpathSync(join(root, "current", EXE)))).toBe(realpathSync(root));

    const userAfter = registryPath("User");
    expect(userAfter.split(";").filter((p) => p !== "")).toEqual([
      ...userBefore.split(";").filter((p) => p !== ""),
      join(root, "current"),
    ]);
    expect(registryPath("Machine")).toBe(machineBefore);

    expect(await runWindows(root)).toMatchObject({ code: 0 });
    expect(registryPath("User")).toBe(userAfter);
  });

  // spec: AC-ARCH-02
  test("refuses a tampered SHA256SUMS or archive, and an untrusted key, leaving the existing install as it was", async () => {
    const root = join(work, `win-${crypto.randomUUID()}`, "dovet");
    await writeRelease("0.1.0");
    expect(await runWindows(root)).toMatchObject({ code: 0 });
    await writeRelease("0.2.0");
    const archive = join(releases, `dovet-0.2.0-${TARGET}.tar.gz`);
    const sums = readFileSync(join(releases, "SHA256SUMS"), "utf8");

    writeFileSync(
      join(releases, "SHA256SUMS"),
      sums.replace(/^./, (c) => (c === "0" ? "1" : "0")),
    );
    const badSums = await runWindows(root);
    expect(badSums.code, badSums.out).not.toBe(0);
    expect(badSums.out.toLowerCase()).toContain("signature");

    writeFileSync(join(releases, "SHA256SUMS"), sums);
    const original = readFileSync(archive);
    writeFileSync(archive, Buffer.concat([original, Buffer.from("x")]));
    const badArchive = await runWindows(root);
    expect(badArchive.code, badArchive.out).not.toBe(0);
    expect(badArchive.out.toLowerCase()).toContain("checksum");

    writeFileSync(archive, original);
    const untrusted = await runWindows(root, { DOVET_RELEASE_PUBLIC_KEYS: (await newKeys()).publicKey });
    expect(untrusted.code, untrusted.out).not.toBe(0);
    expect(untrusted.out.toLowerCase()).toContain("signature");

    expect(readdirSync(join(root, "versions"))).toEqual(["0.1.0"]);
    expect(realpathSync(join(root, "current"))).toBe(realpathSync(join(root, "versions", "0.1.0")));
  });

  test("records the version it left in `previous` when installing a newer one", async () => {
    const root = join(work, `win-${crypto.randomUUID()}`, "dovet");
    await writeRelease("0.1.0");
    expect(await runWindows(root)).toMatchObject({ code: 0 });
    await writeRelease("0.2.0");
    expect(await runWindows(root)).toMatchObject({ code: 0 });
    expect(readFileSync(join(root, "previous"), "utf8").trim()).toBe("0.1.0");
    expect(realpathSync(join(root, "current"))).toBe(realpathSync(join(root, "versions", "0.2.0")));
  });

  // spec: AC-CLI-07
  test("`dovet update` swaps the junction while an older dovet.exe is running", async () => {
    await writeRelease("0.1.0");
    const root = join(work, `win-${crypto.randomUUID()}`, "dovet");
    expect(await runWindows(root)).toMatchObject({ code: 0 });

    const old = join(root, "versions", "0.1.0", EXE);
    copyFileSync(process.execPath, old);
    const running = Bun.spawn([join(root, "current", EXE), "-e", "setTimeout(() => {}, 120000)"], { stdout: "ignore" });
    try {
      await Bun.sleep(1000);
      expect(running.exitCode).toBeNull();
      await writeRelease("0.2.0");
      const result = await update({ root, baseUrl, targetId: TARGET, os: OS, publicKeys: [keys.publicKey] });
      expect(result).toMatchObject({ status: "updated", from: "0.1.0", to: "0.2.0" });
      expect(running.exitCode).toBeNull();
      expect(realpathSync(join(root, "current"))).toBe(realpathSync(join(root, "versions", "0.2.0")));
      expect(existsSync(old)).toBe(true);
    } finally {
      running.kill();
      await running.exited;
    }
  });
});

describe("embedded release keys", () => {
  test("the install scripts embed the same public keys as Dovet", () => {
    const keys = RELEASE_PUBLIC_KEYS.join(",");
    expect(readFileSync(POSIX_SCRIPT, "utf8")).toContain(`DOVET_EMBEDDED_KEYS="${keys}"`);
    expect(readFileSync(WINDOWS_SCRIPT, "utf8")).toContain(`$EmbeddedKeys = "${keys}"`);
  });
});
