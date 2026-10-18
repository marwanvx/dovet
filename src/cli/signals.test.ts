// Process signal and crash handling (agent-loop "Process signals and crashes"); a fake runtime keeps this file off `process.*`.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CRASH, EXIT_SIGHUP, EXIT_SIGINT, EXIT_SIGTERM, type StopSignal } from "../agent/index.ts";
import { installSignalHandlers, stopSignalsFor } from "./signals.ts";

const SIGNALS: readonly StopSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function fakeRuntime() {
  const stops = new Map<StopSignal, () => void>();
  const crashes: Array<(err: unknown) => void> = [];
  const exits: number[] = [];
  const errors: string[] = [];
  let now = 1_000;
  return {
    runtime: {
      onStop: (signal: StopSignal, handler: () => void): void => {
        stops.set(signal, handler);
      },
      onCrash: (handler: (err: unknown) => void): void => {
        crashes.push(handler);
      },
      exit: (code: number): void => {
        exits.push(code);
      },
      now: (): number => now,
      writeErr: (text: string): void => {
        errors.push(text);
      },
    },
    stops,
    crashes,
    exits,
    errors,
    setNow(ms: number): void {
      now = ms;
    },
  };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

function installed(
  f: ReturnType<typeof fakeRuntime>,
  order: string[],
  crashDir = "/tmp/crash",
  killTrees = async (): Promise<void> => {
    order.push("killTrees");
  },
): ReturnType<typeof installSignalHandlers> {
  return installSignalHandlers({
    runtime: f.runtime,
    signals: SIGNALS,
    abort: () => order.push("abort"),
    killTrees,
    crash: { dir: crashDir, versions: { dovet: "9.9.9", os: "linux" } },
  });
}

function fakeSession(order: string[], fail?: Error) {
  return {
    shutdown: async (): Promise<void> => {
      order.push("shutdown");
      if (fail !== undefined) throw fail;
    },
    eventTypes: (): readonly string[] => ["user.message", "model.response"],
  };
}

describe("process signals", () => {
  test("registers exactly the signals it is given", () => {
    const f = fakeRuntime();
    const signals = installed(f, []);
    expect(signals).toBeDefined();
    expect([...f.stops.keys()]).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  // spec: AC-LOOP-09 (Windows console close / Ctrl+Break is the same as SIGTERM)
  test("stop signals include SIGBREAK only on Windows", () => {
    expect(stopSignalsFor("win32")).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);
    expect(stopSignalsFor("linux")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(stopSignalsFor("darwin")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  // spec: AC-LOOP-09
  test("SIGTERM flushes and releases the log, kills the child trees, then exits 143", async () => {
    const f = fakeRuntime();
    const order: string[] = [];
    installed(f, order).attach(fakeSession(order));
    f.stops.get("SIGTERM")?.();
    await until(() => f.exits.length === 1, "the SIGTERM exit");
    expect(f.exits).toEqual([EXIT_SIGTERM]);
    expect(order).toEqual(["shutdown", "abort", "killTrees"]);
    expect(f.errors).toEqual([]);
  });

  // spec: AC-LOOP-09
  test("the exit waits for the child trees to be killed", async () => {
    const f = fakeRuntime();
    const order: string[] = [];
    let killed = false;
    installed(f, order, "/tmp/crash", async () => {
      await Bun.sleep(30);
      killed = true;
    }).attach(fakeSession(order));
    f.stops.get("SIGTERM")?.();
    await until(() => f.exits.length === 1, "the SIGTERM exit");
    expect(f.exits).toEqual([EXIT_SIGTERM]);
    expect(killed).toBe(true);
  });

  test("a kill that fails is reported on stderr and never blocks the exit", async () => {
    const f = fakeRuntime();
    const order: string[] = [];
    installed(f, order, "/tmp/crash", async () => {
      throw new Error("kill denied");
    }).attach(fakeSession(order));
    f.stops.get("SIGTERM")?.();
    await until(() => f.exits.length === 1, "the exit after the failed kill");
    expect(f.exits).toEqual([EXIT_SIGTERM]);
    expect(order).toEqual(["shutdown", "abort"]);
    expect(f.errors.join("")).toContain("kill denied");
  });

  test("SIGHUP exits 129 and SIGBREAK 143 when they are registered", async () => {
    const f = fakeRuntime();
    const order: string[] = [];
    installSignalHandlers({
      runtime: f.runtime,
      signals: ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"],
      abort: () => order.push("abort"),
      killTrees: async () => {
        order.push("killTrees");
      },
      crash: { dir: "/tmp/crash", versions: {} },
    }).attach(fakeSession(order));
    f.stops.get("SIGHUP")?.();
    await until(() => f.exits.length === 1, "the SIGHUP exit");
    expect(f.exits).toEqual([EXIT_SIGHUP]);
    f.stops.get("SIGBREAK")?.();
    await until(() => f.exits.length === 2, "the SIGBREAK exit");
    expect(f.exits).toEqual([EXIT_SIGHUP, EXIT_SIGTERM]);
  });

  test("a shutdown that fails is reported on stderr and never blocks the exit", async () => {
    const f = fakeRuntime();
    const order: string[] = [];
    installed(f, order).attach(fakeSession(order, new Error("disk full")));
    f.stops.get("SIGTERM")?.();
    await until(() => f.exits.length === 1, "the exit after the failed flush");
    expect(f.exits).toEqual([EXIT_SIGTERM]);
    expect(order).toEqual(["shutdown", "abort", "killTrees"]);
    expect(f.errors.join("")).toContain("disk full");
  });

  // spec: AC-LOOP-02
  test("SIGINT aborts the turn and warns; a second press within 1 s flushes and exits 130", async () => {
    const f = fakeRuntime();
    const order: string[] = [];
    installed(f, order).attach(fakeSession(order));
    f.setNow(10_000);
    f.stops.get("SIGINT")?.();
    expect(order).toEqual(["abort"]);
    expect(f.exits).toEqual([]);
    expect(f.errors.join("")).toBe("dovet: interrupted — press Ctrl+C again within 1 s to exit.\n");
    f.setNow(10_999);
    f.stops.get("SIGINT")?.();
    await until(() => f.exits.length === 1, "the second-press exit");
    expect(f.exits).toEqual([EXIT_SIGINT]);
    expect(order).toEqual(["abort", "shutdown", "abort", "killTrees"]);
  });

  // spec: AC-LOOP-02
  test("a SIGINT after the window is a fresh first press, not an exit", () => {
    const f = fakeRuntime();
    const order: string[] = [];
    installed(f, order).attach(fakeSession(order));
    f.setNow(10_000);
    f.stops.get("SIGINT")?.();
    f.setNow(11_000);
    f.stops.get("SIGINT")?.();
    expect(order).toEqual(["abort", "abort"]);
    expect(f.exits).toEqual([]);
    expect(f.errors).toHaveLength(2);
  });

  test("signals before a session attaches are safe: no shutdown, still abort and exit", async () => {
    const f = fakeRuntime();
    const order: string[] = [];
    installed(f, order);
    f.stops.get("SIGTERM")?.();
    await until(() => f.exits.length === 1, "the exit before any attach");
    expect(f.exits).toEqual([EXIT_SIGTERM]);
    expect(order).toEqual(["abort", "killTrees"]);
    expect(f.errors).toEqual([]);
  });

  test("a crash writes the report with types only, then flushes the log and exits 70", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-crash-"));
    try {
      const f = fakeRuntime();
      const order: string[] = [];
      const types = Array.from({ length: 60 }, (_, i) => `event:${i}`);
      let reportsAtShutdown: string[] = [];
      const session = {
        shutdown: async (): Promise<void> => {
          order.push("shutdown");
          reportsAtShutdown = await readdir(dir);
        },
        eventTypes: (): readonly string[] => types,
      };
      installed(f, order, dir).attach(session);
      f.crashes[0]?.(new Error("boom"));
      await until(() => f.exits.length === 1, "the crash exit");
      expect(f.exits).toEqual([EXIT_CRASH]);
      expect(order).toEqual(["shutdown"]);
      expect(reportsAtShutdown).toHaveLength(1);
      const name = reportsAtShutdown[0] ?? "";
      expect(name.startsWith("crash-") && name.endsWith(".json")).toBe(true);
      expect(f.errors.join("")).toContain(join(dir, name));
      const report = JSON.parse(await readFile(join(dir, name), "utf8")) as {
        stack: string;
        versions: Record<string, string>;
        eventTypes: string[];
      };
      expect(report.stack).toContain("boom");
      expect(report.versions).toEqual({ dovet: "9.9.9", os: "linux" });
      expect(report.eventTypes).toEqual(types.slice(-50));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a crash before a session attaches still writes the report and exits 70", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-crash-"));
    try {
      const f = fakeRuntime();
      const order: string[] = [];
      installed(f, order, dir);
      f.crashes[0]?.("a rejection");
      await until(() => f.exits.length === 1, "the crash exit without a session");
      expect(f.exits).toEqual([EXIT_CRASH]);
      expect(order).toEqual([]);
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const report = JSON.parse(await readFile(join(dir, files[0] ?? ""), "utf8")) as {
        stack: string;
        eventTypes: string[];
      };
      expect(report.stack).toContain("a rejection");
      expect(report.eventTypes).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a report that can't be written is reported, the log still flushes, exit stays 70", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dovet-crash-"));
    try {
      await writeFile(join(dir, "blocker"), "x");
      const f = fakeRuntime();
      const order: string[] = [];
      installed(f, order, join(dir, "blocker", "crash")).attach(fakeSession(order));
      f.crashes[0]?.(new Error("boom"));
      await until(() => f.exits.length === 1, "the crash exit despite the report failure");
      expect(f.exits).toEqual([EXIT_CRASH]);
      expect(order).toEqual(["shutdown"]);
      expect(f.errors.join("")).toContain("crash report");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
