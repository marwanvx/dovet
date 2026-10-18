// spec: AC-LOOP-09
import { expect, test } from "bun:test";
import type { AbsPath } from "../schema/index.ts";
import { createProcessManager } from "./process.ts";
import type { Os } from "./types.ts";

test.skipIf(process.platform === "win32")(
  "a second killTrees waits for the escalation the first started instead of returning early",
  async () => {
    const os: Os = process.platform === "darwin" ? "darwin" : "linux";
    const signals: Array<NodeJS.Signals | 0> = [];
    const manager = createProcessManager({
      os,
      env: {},
      // Every liveness probe answers "alive" so the escalation runs its full path; the real child is cleaned up below.
      kill: (_pid, signal) => {
        signals.push(signal);
      },
      termGraceMs: 300,
    });
    const ac = new AbortController();
    const child = manager.spawn({
      argv: ["/bin/sh", "-c", "sleep 30"],
      cwd: "/" as AbsPath,
      env: {},
      stdin: "null",
      signal: ac.signal,
      group: "g",
    });
    try {
      const first = manager.killTrees();
      const second = manager.killTrees();
      await second;
      expect(signals).toContain("SIGKILL");
      await first;
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already dead
      }
      await Promise.race([child.exited, Bun.sleep(1_000)]).catch(() => undefined);
    }
  },
);
