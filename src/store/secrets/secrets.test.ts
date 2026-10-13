import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type TempProject, tempProject } from "../../../test/helpers/index.ts";
import {
  type CommandRunner,
  CredentialError,
  createCredentials,
  createSecretStore,
  type KeychainBackend,
  type ProviderAuth,
  Secret,
} from "./index.ts";

const KEY = "nvapi-FAKE-TEST-VALUE-NOT-A-REAL-KEY";
const NVIDIA: ProviderAuth = { id: "nvidia", envVars: ["NVIDIA_API_KEY"] };
const EXAMPLE: ProviderAuth = {
  id: "example",
  envVars: ["EXAMPLE_API_KEY"],
  exclusiveEnvVars: ["EXAMPLE_API_KEY", "EXAMPLE_AUTH_TOKEN"],
};

function fakeKeychain(entries: Record<string, string> = {}): KeychainBackend & { calls: unknown[] } {
  const store = new Map(Object.entries(entries));
  const calls: unknown[] = [];
  return {
    calls,
    get: (o) => Promise.resolve(store.get(`${o.service}/${o.name}`) ?? null),
    set: (o) => {
      calls.push(o);
      store.set(`${o.service}/${o.name}`, o.value);
      return Promise.resolve();
    },
    delete: (o) => Promise.resolve(store.delete(`${o.service}/${o.name}`)),
  };
}

function platformError(): Error {
  return Object.assign(new Error("libsecret not available"), { code: "ERR_SECRETS_PLATFORM_ERROR" });
}

const noKeychain: KeychainBackend = {
  get: () => Promise.reject(platformError()),
  set: () => Promise.reject(platformError()),
  delete: () => Promise.reject(platformError()),
};

const noCommands: CommandRunner = () => Promise.reject(new Error("no command should run"));

let dir: TempProject | undefined;
afterEach(async () => {
  await dir?.dispose();
  dir = undefined;
});

async function tempFile(): Promise<string> {
  dir = await tempProject();
  return join(dir.root, "data", "credentials.json");
}

describe("Secret", () => {
  // spec: AC-CLI-17
  test("never shows its value when logged, printed, interpolated or serialized", () => {
    const s = new Secret(KEY);
    const shown = [
      String(s),
      `${s}`,
      JSON.stringify({ apiKey: s }),
      Bun.inspect(s),
      Bun.inspect({ nested: { s } }),
      Bun.inspect(new Error("failed", { cause: s })),
    ];
    for (const text of shown) expect(text).not.toContain(KEY);
    expect(s.reveal()).toBe(KEY);
  });
});

describe("secret store", () => {
  test("stores in the keychain under service dovet, kept on this machine on Windows", async () => {
    const keychain = fakeKeychain();
    const store = createSecretStore({ os: "win32", file: await tempFile(), keychain });
    expect(await store.set("nvidia", new Secret(KEY))).toBe("keychain");
    expect(keychain.calls).toEqual([{ service: "dovet", name: "nvidia", value: KEY, persist: "local" }]);
    const got = await store.get("nvidia");
    expect(got?.location).toBe("keychain");
    expect(got?.secret.reveal()).toBe(KEY);
    expect(await store.delete("nvidia")).toBe(true);
    expect(await store.get("nvidia")).toBeUndefined();
  });

  test("on Linux without a Secret Service, falls back to a file only the user can read", async () => {
    const file = await tempFile();
    const store = createSecretStore({ os: "linux", file, keychain: noKeychain });
    expect(await store.set("nvidia", new Secret(KEY))).toBe("file");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ nvidia: KEY });
    const got = await store.get("nvidia");
    expect(got?.location).toBe("file");
    expect(got?.secret.reveal()).toBe(KEY);
    expect(await store.delete("nvidia")).toBe(true);
    expect(await store.get("nvidia")).toBeUndefined();
  });

  test("on macOS and Windows a keychain failure is reported, never written to a file", async () => {
    const file = await tempFile();
    for (const os of ["darwin", "win32"] as const) {
      const store = createSecretStore({ os, file, keychain: noKeychain });
      await expect(store.set("nvidia", new Secret(KEY))).rejects.toThrow("libsecret not available");
    }
    await expect(stat(file)).rejects.toThrow();
  });

  test("a denied keychain prompt is an error, not a reason to use the file", async () => {
    const denied: KeychainBackend = {
      ...noKeychain,
      set: () => Promise.reject(Object.assign(new Error("denied"), { code: "ERR_SECRETS_USER_CANCELED" })),
    };
    const file = await tempFile();
    const store = createSecretStore({ os: "linux", file, keychain: denied });
    await expect(store.set("nvidia", new Secret(KEY))).rejects.toThrow("denied");
    await expect(stat(file)).rejects.toThrow();
  });
});

describe("credential resolution", () => {
  async function setup(opts: {
    reference?: string;
    env?: Record<string, string>;
    keychain?: Record<string, string>;
    run?: CommandRunner;
    timeoutMs?: number;
  }) {
    const store = createSecretStore({ os: "darwin", file: await tempFile(), keychain: fakeKeychain(opts.keychain) });
    return createCredentials({
      store,
      env: opts.env ?? {},
      runCommand: opts.run ?? noCommands,
      ...(opts.timeoutMs === undefined ? {} : { commandTimeoutMs: opts.timeoutMs }),
      providers: {
        nvidia: { auth: NVIDIA, ...(opts.reference ? { reference: opts.reference } : {}) },
        example: { auth: EXAMPLE },
      },
    });
  }

  test("settings reference wins over the stored login, which wins over the standard env var", async () => {
    const all = await setup({
      reference: "env:WORK_KEY",
      env: { WORK_KEY: "from-work", NVIDIA_API_KEY: "from-env" },
      keychain: { "dovet/nvidia": "from-login" },
    });
    expect((await all.resolve("nvidia"))?.secret?.reveal()).toBe("from-work");

    const noRef = await setup({
      env: { NVIDIA_API_KEY: "from-env" },
      keychain: { "dovet/nvidia": "from-login" },
    });
    const login = await noRef.resolve("nvidia");
    expect(login?.secret?.reveal()).toBe("from-login");
    expect(login?.source).toEqual({ kind: "login", location: "keychain" });

    const envOnly = await setup({ env: { NVIDIA_API_KEY: "from-env" } });
    const env = await envOnly.resolve("nvidia");
    expect(env?.secret?.reveal()).toBe("from-env");
    expect(env?.source).toEqual({ kind: "env", name: "NVIDIA_API_KEY" });

    expect(await (await setup({})).resolve("nvidia")).toBeUndefined();
  });

  test("keychain:<name> reads that keychain entry; none means no key", async () => {
    const c = await setup({ reference: "keychain:work", keychain: { "dovet/work": "from-work-entry" } });
    expect((await c.resolve("nvidia"))?.secret?.reveal()).toBe("from-work-entry");
    const none = await (await setup({ reference: "none", env: { NVIDIA_API_KEY: "x" } })).resolve("nvidia");
    expect(none).toEqual({ source: { kind: "settings", reference: "none" }, warnings: [] });
  });

  test("a reference to a missing env var or keychain entry is an error, not a silent fall-through", async () => {
    const env = await setup({ reference: "env:WORK_KEY", env: { NVIDIA_API_KEY: "x" } });
    await expect(env.resolve("nvidia")).rejects.toThrow("WORK_KEY is not set");
    const kc = await setup({ reference: "keychain:work" });
    await expect(kc.resolve("nvidia")).rejects.toThrow('keychain entry "work"');
  });

  test("cmd: runs the command once per session and keeps its trimmed output", async () => {
    const ran: string[] = [];
    const c = await setup({
      reference: "cmd:op read op://dev/nvidia/key",
      run: (command) => {
        ran.push(command);
        return Promise.resolve({ exitCode: 0, stdout: `${KEY}\n` });
      },
    });
    expect((await c.resolve("nvidia"))?.secret?.reveal()).toBe(KEY);
    expect((await c.resolve("nvidia"))?.secret?.reveal()).toBe(KEY);
    expect(ran).toEqual(["op read op://dev/nvidia/key"]);
  });

  // spec: AC-CLI-17
  test("a failing cmd: names the command, never its output", async () => {
    const cases: CommandRunner[] = [
      () => Promise.resolve({ exitCode: 1, stdout: KEY }),
      () => Promise.resolve({ exitCode: 0, stdout: "  \n" }),
      (_c, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    ];
    for (const run of cases) {
      const c = await setup({ reference: "cmd:get-key --work", run, timeoutMs: 20 });
      const err = await c.resolve("nvidia").then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CredentialError);
      const text = `${(err as Error).message} ${Bun.inspect(err)}`;
      expect(text).toContain("get-key --work");
      expect(text).not.toContain(KEY);
    }
  });

  test("warns when two env vars the provider rejects together are both set", async () => {
    const c = await setup({ env: { EXAMPLE_API_KEY: KEY, EXAMPLE_AUTH_TOKEN: "tok" } });
    const r = await c.resolve("example");
    expect(r?.warnings).toEqual([
      "EXAMPLE_API_KEY and EXAMPLE_AUTH_TOKEN are both set; example rejects requests that carry both (401). Unset one of them.",
    ]);
    expect((await c.status("example")).warnings).toEqual(r?.warnings ?? []);
    const one = await setup({ env: { EXAMPLE_API_KEY: KEY } });
    expect((await one.resolve("example"))?.warnings).toEqual([]);
  });

  // spec: AC-CLI-17
  test("status lists every source that has a credential, which one is used, and never a value", async () => {
    const c = await setup({
      reference: "cmd:get-key",
      env: { NVIDIA_API_KEY: KEY },
      keychain: { "dovet/nvidia": KEY },
    });
    const s = await c.status("nvidia");
    expect(s.sources).toEqual([
      { source: { kind: "settings", reference: "cmd" }, used: true },
      { source: { kind: "login", location: "keychain" }, used: false },
      { source: { kind: "env", name: "NVIDIA_API_KEY" }, used: false },
    ]);
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
});
