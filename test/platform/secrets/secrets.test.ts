// SPIKE-5: Dovet's secret store in a compiled binary per OS; Linux also without a Secret Service and with gnome-keyring.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDovet } from "../../../scripts/build.ts";

const EXE = process.platform === "win32" ? ".exe" : "";
let dir = "";
let probe = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dovet-secrets-"));
  probe = join(dir, `probe${EXE}`);
  await compileDovet({ entry: join(import.meta.dir, "secrets-probe.ts"), outfile: probe });
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function run(argv: string[], env: Record<string, string | undefined>) {
  const file = join(dir, `credentials-${crypto.randomUUID()}.json`);
  const r = Bun.spawnSync([...argv, probe, file, `dovet-test-${crypto.randomUUID()}`], { env, timeout: 30_000 });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`probe exited ${r.exitCode}: ${r.stderr.toString()}`);
  return { result: JSON.parse(out) as Record<string, unknown>, file };
}

const roundTrip = { readBack: true, deleted: true, gone: true };
const linux = process.platform === "linux";
const keyring = linux && Bun.which("gnome-keyring-daemon") !== null && Bun.which("dbus-run-session") !== null;

describe("SPIKE-5: secrets in the compiled binary", () => {
  test.if(linux && process.env.CI !== undefined)(
    "Linux CI has gnome-keyring and D-Bus, so the keychain case runs",
    () => {
      expect(keyring).toBe(true);
    },
  );

  test.if(!linux)(
    "macOS and Windows store in the OS keychain",
    () => {
      const { result } = run([], process.env);
      expect(result).toEqual({ location: "keychain", readFrom: "keychain", ...roundTrip });
    },
    30_000,
  );

  test.if(linux)(
    "Linux without a Secret Service falls back to a 0600 file",
    () => {
      const { DBUS_SESSION_BUS_ADDRESS: _, DISPLAY: __, ...env } = process.env;
      const { result, file } = run([], env);
      expect(result).toEqual({ location: "file", readFrom: "file", ...roundTrip });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
    30_000,
  );

  test.if(keyring)(
    "Linux with an unlocked Secret Service uses it",
    () => {
      const { DBUS_SESSION_BUS_ADDRESS: _, ...env } = process.env;
      const home = join(dir, "home");
      mkdirSync(join(home, ".cache"), { recursive: true });
      const script = 'eval "$(printf pw | gnome-keyring-daemon --unlock --components=secrets)" >/dev/null; exec "$@"';
      const { result, file } = run(["dbus-run-session", "--", "sh", "-c", script, "sh"], {
        ...env,
        HOME: home,
        XDG_DATA_HOME: join(home, "share"),
      });
      expect(result).toEqual({ location: "keychain", readFrom: "keychain", ...roundTrip });
      expect(() => statSync(file)).toThrow();
    },
    30_000,
  );
});
