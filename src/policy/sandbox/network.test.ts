// M2-02 network helpers failing tests first (permissions §7.4): registry, local refusal, taint trigger.
import { describe, expect, test } from "bun:test";
import {
  extractHosts,
  hostNeedsTaint,
  isLoopbackName,
  isRegistryHost,
  makeHostAsker,
  shouldRefuseLocalHost,
  taintSourceForCommand,
} from "./network.ts";

// spec: AC-PERM-11
describe("local-address refusal", () => {
  test("loopback names are allowed; link-local and loopback literals are refused", () => {
    expect(isLoopbackName("localhost")).toBe(true);
    expect(isLoopbackName("api.localhost")).toBe(true);
    expect(isLoopbackName("example.com")).toBe(false);
    expect(shouldRefuseLocalHost("169.254.169.254")).toBe(true);
    expect(shouldRefuseLocalHost("127.0.0.1")).toBe(true);
    expect(shouldRefuseLocalHost("localhost")).toBe(false);
    expect(shouldRefuseLocalHost("registry.npmjs.org")).toBe(false);
  });
  test("an explicitly allowed IP:port is not refused", () => {
    expect(shouldRefuseLocalHost("127.0.0.1:8080", ["127.0.0.1:8080"])).toBe(false);
    expect(shouldRefuseLocalHost("127.0.0.1:8080", ["127.0.0.1:9090"])).toBe(true);
  });
});

// spec: AC-PERM-27
describe("taint trigger from proxy hosts", () => {
  test("registry hosts do not taint; arbitrary hosts do", () => {
    expect(isRegistryHost("registry.npmjs.org")).toBe(true);
    expect(isRegistryHost("REGISTRY.NPMJS.ORG.")).toBe(true);
    expect(isRegistryHost("example.com")).toBe(false);
    expect(hostNeedsTaint("registry.npmjs.org")).toBe(false);
    expect(hostNeedsTaint("example.com")).toBe(true);
    expect(hostNeedsTaint("localhost")).toBe(false);
  });
  test("a curl to a non-registry host names a taint source; registry does not", () => {
    expect(taintSourceForCommand("curl https://example.com/x")).toBe("sandbox: example.com");
    expect(taintSourceForCommand("npm install")).toBeUndefined();
    expect(taintSourceForCommand("curl https://registry.npmjs.org/a")).toBeUndefined();
    expect(extractHosts("curl https://a.example/a https://b.example/b")).toEqual(["a.example", "b.example"]);
  });
});

// spec: AC-PERM-11
describe("proxy allowlist asker", () => {
  test("denied always refused; strict refuses without asking; dontAsk refuses; bypass allows", async () => {
    let asked = 0;
    const base = {
      allowedDomains: ["registry.npmjs.org"],
      deniedDomains: ["evil.example"],
      strictAllowlist: false,
      ask: async (_h: string) => {
        asked++;
        return true;
      },
    };
    expect(await makeHostAsker({ ...base, mode: "default" })({ host: "evil.example", port: 443 })).toBe(false);
    expect(await makeHostAsker({ ...base, mode: "default" })({ host: "registry.npmjs.org", port: 443 })).toBe(true);
    expect(asked).toBe(0);
    expect(await makeHostAsker({ ...base, mode: "default" })({ host: "new.example", port: 443 })).toBe(true);
    expect(asked).toBe(1);
    expect(await makeHostAsker({ ...base, mode: "dontAsk" })({ host: "new2.example", port: 443 })).toBe(false);
    expect(asked).toBe(1);
    expect(await makeHostAsker({ ...base, mode: "bypassPermissions" })({ host: "new3.example", port: 443 })).toBe(true);
    expect(asked).toBe(1);
    expect(
      await makeHostAsker({ ...base, mode: "default", strictAllowlist: true })({ host: "new4.example", port: 443 }),
    ).toBe(false);
    expect(await makeHostAsker({ ...base, mode: "default" })({ host: "169.254.169.254", port: 80 })).toBe(false);
  });
  test("an explicitly allowed local IP:port is allowed; other ports are refused", async () => {
    const ask = makeHostAsker({
      mode: "default",
      allowedDomains: ["registry.npmjs.org", "127.0.0.1:8080"],
      deniedDomains: [],
      strictAllowlist: false,
      ask: async () => true,
    });
    expect(await ask({ host: "127.0.0.1", port: 8080 })).toBe(true);
    expect(await ask({ host: "127.0.0.1", port: 9090 })).toBe(false);
  });
});
