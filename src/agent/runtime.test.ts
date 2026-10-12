import { describe, expect, test } from "bun:test";
import { fakeClock, fakePlatform, sequentialIds } from "../../test/helpers/index.ts";
import { createRuntime, type RuntimeDeps } from "./index.ts";

function deps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    clock: fakeClock(),
    ids: sequentialIds(),
    platform: fakePlatform(),
    dirs: { config: "/cfg", data: "/data", cache: "/cache" },
    env: {},
    stdio: { isTTY: false },
    ...overrides,
  };
}

describe("createRuntime", () => {
  test("two Runtimes in one process share no state", async () => {
    const clockA = fakeClock(1_000);
    const clockB = fakeClock(9_000);
    const a = createRuntime(deps({ clock: clockA, ids: sequentialIds("A") }));
    const b = createRuntime(deps({ clock: clockB, ids: sequentialIds("B") }));

    clockA.advance(500);
    expect(a.deps.clock.now()).toBe(1_500);
    expect(b.deps.clock.now()).toBe(9_000);
    expect(a.deps.ids.ulid()).not.toBe(b.deps.ids.ulid());

    await a.close();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(b.deps.clock.now()).toBe(9_000);
    await b.close();
  });

  test("a Runtime created after another one closed starts fresh", async () => {
    const first = createRuntime(deps());
    await first.close();
    const second = createRuntime(deps());
    expect(second.closed).toBe(false);
    await second.close();
  });

  test("the environment is a frozen copy taken once: later changes to the caller's object don't leak in", async () => {
    const source: Record<string, string> = { HOME: "/home/u" };
    const runtime = createRuntime(deps({ env: source }));
    source.HOME = "/elsewhere";
    source.NEW = "1";
    expect(runtime.deps.env).toEqual({ HOME: "/home/u" });
    expect(Object.isFrozen(runtime.deps.env)).toBe(true);
    expect(Object.isFrozen(runtime.deps.dirs)).toBe(true);
    await runtime.close();
  });

  test("close is idempotent", async () => {
    const runtime = createRuntime(deps());
    await runtime.close();
    await runtime.close();
    expect(runtime.closed).toBe(true);
  });

  test("createRuntime never touches the real process environment or directory", async () => {
    const before = { env: JSON.stringify(process.env), cwd: process.cwd() };
    const runtime = createRuntime(deps({ env: { DOVET_X: "1" } }));
    await runtime.close();
    expect(JSON.stringify(process.env)).toBe(before.env);
    expect(process.cwd()).toBe(before.cwd);
  });
});
