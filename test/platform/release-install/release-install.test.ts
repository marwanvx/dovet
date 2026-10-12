// A normal build has no update override; a test release (pull request) installs, updates and rolls back (needs DOVET_RELEASE_DIR).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pkg from "../../../package.json";
import { compileDovet } from "../../../scripts/build.ts";
import { nextPatch, TEST_UPDATE_URL, testUpdateDefine } from "../../../scripts/build-release.ts";

const WINDOWS = process.platform === "win32";
const EXE = WINDOWS ? "dovet.exe" : "dovet";
const MAIN = join(import.meta.dir, "../../../src/cli/main.ts");
const FAKE_KEY = Buffer.from("test-key-that-is-not-a-real-key!").toString("base64");
if (WINDOWS) setDefaultTimeout(120_000);

describe("test release build", () => {
  let dir = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dovet-test-release-"));
    await compileDovet({ entry: MAIN, outfile: join(dir, `normal${WINDOWS ? ".exe" : ""}`) });
    await compileDovet({
      entry: MAIN,
      outfile: join(dir, `test${WINDOWS ? ".exe" : ""}`),
      define: testUpdateDefine({ publicKey: FAKE_KEY, baseUrl: TEST_UPDATE_URL }),
    });
  }, 120_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const holds = (name: string, text: string) =>
    Buffer.from(readFileSync(join(dir, `${name}${WINDOWS ? ".exe" : ""}`))).includes(text);

  test("a normal build holds no update override: not the identifier, the loopback URL or a key", () => {
    expect(holds("normal", "DOVET_TEST_UPDATE")).toBe(false);
    expect(holds("normal", "127.0.0.1:47231")).toBe(false);
  });

  test("a test build holds the loopback update URL and the test key", () => {
    expect(holds("test", TEST_UPDATE_URL)).toBe(true);
    expect(holds("test", FAKE_KEY)).toBe(true);
  });

  test("the next release's version is the next patch", () => {
    expect(nextPatch("0.1.9")).toBe("0.1.10");
    expect(nextPatch("1.2.3")).toBe("1.2.4");
    expect(() => nextPatch("1.2")).toThrow("not a plain");
  });
});

const releaseDir = process.env.DOVET_RELEASE_DIR;
const nextDir = process.env.DOVET_NEXT_RELEASE_DIR;
const testKey = process.env.DOVET_RELEASE_TEST_PUBLIC_KEY;

type Run = { code: number; out: string };

async function run(cmd: string[], env: Record<string, string>, cwd?: string): Promise<Run> {
  const r = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env, ...(cwd ? { cwd } : {}) });
  const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited]);
  return { code, out: `${out}${err}` };
}

function serve(dir: string, port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const file = Bun.file(join(dir, basename(new URL(req.url).pathname)));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
}

describe.skipIf(!releaseDir)("the built test release", () => {
  let work = "";
  let root = "";
  let installed = "";
  const servers: ReturnType<typeof serve>[] = [];
  const installedExe = () => realpathSync(installed);
  const current = () => basename(realpathSync(join(root, "current")));
  const dovet = (...args: string[]) => run([installed, ...args], { ...process.env } as Record<string, string>);

  beforeAll(async () => {
    if (!releaseDir) throw new Error("DOVET_RELEASE_DIR is required");
    work = mkdtempSync(join(tmpdir(), "dovet-release-install-"));
    const home = join(work, "home");
    mkdirSync(home);
    const releases = serve(releaseDir, 0);
    servers.push(releases);
    const baseUrl = `http://127.0.0.1:${releases.port}`;
    const hooks = { DOVET_BASE_URL: baseUrl, ...(testKey ? { DOVET_RELEASE_PUBLIC_KEYS: testKey } : {}) };
    let r: Run;
    if (WINDOWS) {
      root = join(work, "dovet");
      r = await run(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `iex (Get-Content -Raw -Encoding UTF8 '${join(import.meta.dir, "../../../install/install.ps1")}')`,
        ],
        { ...process.env, ...hooks, DOVET_INSTALL_DIR: root, DOVET_NONINTERACTIVE: "1" } as Record<string, string>,
      );
      installed = join(root, "current", EXE);
    } else {
      root = join(home, ".local", "share", "dovet");
      r = await run(
        [Bun.which("sh") ?? "sh", join(import.meta.dir, "../../../install/install.sh")],
        { PATH: process.env.PATH ?? "", HOME: home, ...hooks },
        home,
      );
      installed = join(home, ".local", "bin", "dovet");
    }
    if (r.code !== 0) throw new Error(`install failed (${r.code}): ${r.out}`);
    if (nextDir) servers.push(serve(nextDir, 47231));
  }, 180_000);

  afterAll(async () => {
    for (const s of servers) await s.stop(true);
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test("the installed binary runs and prints its version", async () => {
    expect(await dovet("--version")).toEqual({ code: 0, out: `dovet ${pkg.version}\n` });
    expect(current()).toBe(pkg.version);
  });

  test.skipIf(!!testKey)("a tag release's installed binary holds no update override", () => {
    const bytes = readFileSync(installedExe());
    expect(bytes.includes("DOVET_TEST_UPDATE")).toBe(false);
    expect(bytes.includes("127.0.0.1:47231")).toBe(false);
  });

  test.skipIf(!nextDir)(
    "dovet update installs the next signed release, and --rollback twice goes back and forth",
    async () => {
      const next = nextPatch(pkg.version);
      const updated = await dovet("update");
      expect(updated.out).toContain(`Updated dovet ${pkg.version} to ${next}`);
      expect(updated.code).toBe(0);
      expect(current()).toBe(next);
      expect((await dovet("--version")).code).toBe(0);

      const back = await dovet("update", "--rollback");
      expect(back.out).toContain(`Rolled back dovet ${next} to ${pkg.version}`);
      expect(current()).toBe(pkg.version);

      const forward = await dovet("update", "--rollback");
      expect(forward.out).toContain(`Rolled back dovet ${pkg.version} to ${next}`);
      expect(current()).toBe(next);
      expect(readFileSync(join(root, "previous"), "utf8").trim()).toBe(pkg.version);
      if (!WINDOWS) expect(readlinkSync(join(root, "current"))).toBe(join("versions", next));
    },
  );

  test.skipIf(!nextDir)("a second update finds nothing newer", async () => {
    expect((await dovet("update")).out).toContain("is up to date");
  });
});
