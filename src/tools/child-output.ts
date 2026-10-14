// Reading a child's output (tools §5.5): completion is the process exit, then pipes held open by grandchildren are drained for at most 500 ms.
import type { ChildHandle } from "../platform/index.ts";

export const DRAIN_MS = 500;

export type ChildOutput = { stdout: Buffer; stderr: Buffer; merged: Buffer; code: number | null };

export type CollectOptions = {
  onChunk?: (chunk: Uint8Array) => void;
  /** Runs once the process has exited, before the pipes are drained (the sweep of processes that kept them open). */
  afterExit?: () => Promise<void>;
  /** Stops reading and calls `onLimit` once the merged output passes this many bytes. */
  maxBytes?: number;
  onLimit?: () => void;
};

export async function collectOutput(child: ChildHandle, opts: CollectOptions = {}): Promise<ChildOutput> {
  const { onChunk, afterExit, maxBytes, onLimit } = opts;
  let total = 0;
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  const merged: Uint8Array[] = [];
  const readers = [
    { reader: child.stdout.getReader(), into: out },
    { reader: child.stderr.getReader(), into: err },
  ];
  const drained = Promise.all(
    readers.map(async ({ reader, into }) => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (maxBytes !== undefined && total > maxBytes) continue;
        total += value.length;
        into.push(value);
        merged.push(value);
        onChunk?.(value);
        if (maxBytes !== undefined && total > maxBytes) onLimit?.();
      }
    }),
  );
  let code: number | null;
  try {
    code = await child.exited;
    await afterExit?.();
    await Promise.race([drained, Bun.sleep(DRAIN_MS)]);
  } finally {
    await Promise.all(readers.map(({ reader }) => reader.cancel()));
  }
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err), merged: Buffer.concat(merged), code };
}
