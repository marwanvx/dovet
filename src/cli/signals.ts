// Process signal and crash handling (agent-loop "Process signals and crashes"), with the runtime injected.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCrashReport,
  EXIT_CRASH,
  type StopSignal,
  secondSignalExits,
  shutdownPlan,
  sigintOutcome,
} from "../agent/index.ts";
import type { Os } from "../platform/index.ts";

export type SignalRuntime = {
  onStop(signal: StopSignal, handler: () => void): void;
  onCrash(handler: (err: unknown) => void): void;
  exit(code: number): void;
  now(): number;
  writeErr(text: string): void;
};

export type SessionHandle = {
  shutdown(): Promise<void>;
  eventTypes(): readonly string[];
};

export type SignalHandlers = { attach(session: SessionHandle): void };

/** AC-LOOP-09: Windows console close / Ctrl+Break is the same as SIGTERM (agent-loop "Process signals and crashes"). */
export function stopSignalsFor(os: Os): readonly StopSignal[] {
  return os === "win32" ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function installSignalHandlers(input: {
  runtime: SignalRuntime;
  signals: readonly StopSignal[];
  abort: () => void;
  /** AC-LOOP-09: ends every child tree and resolves when the SIGTERM→SIGKILL escalation is done. */
  killTrees: () => Promise<void>;
  crash: { dir: string; versions: Record<string, string> };
}): SignalHandlers {
  const { runtime } = input;
  let session: SessionHandle | undefined;
  let sawSigint = false;
  let lastSigint = Number.NEGATIVE_INFINITY;

  // AC-LOOP-09: flush and release the log first, then abort — child trees get SIGTERM, then SIGKILL after
  // the grace period, and the exit waits for that escalation. Never write synthetic results for a stop.
  const flushThenExit = async (exitCode: number): Promise<void> => {
    try {
      await session?.shutdown();
    } catch (err) {
      runtime.writeErr(`dovet: could not flush the session log: ${messageOf(err)}\n`);
    }
    input.abort();
    try {
      await input.killTrees();
    } catch (err) {
      runtime.writeErr(`dovet: could not kill the running commands: ${messageOf(err)}\n`);
    }
    runtime.exit(exitCode);
  };

  for (const signal of input.signals) {
    if (signal === "SIGINT") {
      runtime.onStop("SIGINT", () => {
        const now = runtime.now();
        const outcome = sigintOutcome({ first: !sawSigint, withinWindow: secondSignalExits(lastSigint, now) });
        sawSigint = true;
        lastSigint = now;
        if (outcome.action === "exit") {
          void flushThenExit(outcome.exitCode);
          return;
        }
        input.abort();
        runtime.writeErr("dovet: interrupted — press Ctrl+C again within 1 s to exit.\n");
      });
    } else {
      runtime.onStop(signal, () => {
        void flushThenExit(shutdownPlan(signal).exitCode);
      });
    }
  }

  runtime.onCrash((err) => {
    void (async () => {
      let reportPath: string | undefined;
      try {
        const report = buildCrashReport({
          stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
          versions: input.crash.versions,
          eventTypes: session?.eventTypes() ?? [],
          nowMs: runtime.now(),
        });
        await mkdir(input.crash.dir, { recursive: true });
        reportPath = join(input.crash.dir, report.filename);
        await writeFile(reportPath, report.text);
      } catch (writeErr) {
        runtime.writeErr(`dovet: could not write the crash report: ${messageOf(writeErr)}\n`);
      }
      try {
        await session?.shutdown();
      } catch (shutdownErr) {
        runtime.writeErr(`dovet: could not flush the session log: ${messageOf(shutdownErr)}\n`);
      }
      if (reportPath !== undefined) runtime.writeErr(`dovet: crashed; the report is at ${reportPath}\n`);
      runtime.exit(EXIT_CRASH);
    })();
  });

  return {
    attach(next: SessionHandle): void {
      session = next;
    },
  };
}
