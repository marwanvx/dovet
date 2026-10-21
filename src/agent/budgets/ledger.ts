// The per-day reservation ledger (receipts-budgets "Behavior" 5): append-only lines under a short-held exclusive lock file.
import { appendFile, mkdir, open, readFile, stat, unlink } from "node:fs/promises";

const LOCK_STALE_MS = 2000;
const LOCK_WAIT_MS = 10_000;

export type LedgerOptions = {
  /** `<data>/budget` */
  dir: string;
  session: string;
  now: () => number;
  /** Lock age after which another process takes it over. */
  staleMs?: number;
  /** How long a reservation waits for the lock before it fails. */
  waitMs?: number;
};

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

async function statOrNull(path: string): Promise<{ mtimeMs: number } | null> {
  return stat(path).catch((err: unknown) => {
    if (missing(err)) return null;
    throw err;
  });
}

async function unlinkIfThere(path: string): Promise<void> {
  await unlink(path).catch((err: unknown) => {
    if (!missing(err)) throw err;
  });
}

export type Reservation = { ok: boolean; daySpent: number };

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

const fixed = (n: number): string => n.toFixed(6);

/** Last line per request wins; a reserve without a later commit or release counts at its estimate. */
function sumOf(text: string): number {
  const amounts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f[0] === "reserve" && f.length === 5) amounts.set(f[2] ?? "", Number(f[3]));
    else if (f[0] === "commit" && f.length === 3) amounts.set(f[1] ?? "", Number(f[2]));
    else if (f[0] === "release" && f.length === 2) amounts.set(f[1] ?? "", 0);
  }
  let sum = 0;
  for (const v of amounts.values()) if (Number.isFinite(v)) sum += v;
  return sum;
}

export class DailyLedger {
  private readonly day = new Map<string, string>();
  private readonly open = new Set<string>();

  constructor(private readonly o: LedgerOptions) {}

  private file(day: string): string {
    return `${this.o.dir}/${day}.ledger`;
  }

  private async locked<T>(day: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
    const lock = `${this.file(day)}.lock`;
    const stale = this.o.staleMs ?? LOCK_STALE_MS;
    const deadline = Date.now() + (this.o.waitMs ?? LOCK_WAIT_MS);
    for (;;) {
      try {
        const h = await open(lock, "wx", 0o600);
        await h.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const seen = await statOrNull(lock);
        if (seen !== null && Date.now() - seen.mtimeMs > stale) {
          const again = await statOrNull(lock);
          if (again !== null && again.mtimeMs === seen.mtimeMs) await unlinkIfThere(lock);
          continue;
        }
        if (Date.now() > deadline)
          throw new Error(`the budget ledger is locked (${lock}); remove it if no Dovet is running`);
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
      }
    }
    try {
      return await fn();
    } finally {
      await unlinkIfThere(lock);
    }
  }

  private async read(day: string): Promise<string> {
    return readFile(this.file(day), "utf8").catch((err: unknown) => {
      if (missing(err)) return "";
      throw err;
    });
  }

  private append(day: string, line: string): Promise<void> {
    return appendFile(this.file(day), `${line}\n`, { mode: 0o600 });
  }

  /** `limit: null` records the reservation without refusing it. A refused request leaves no line. */
  async reserve(requestId: string, estimate: number, limit: number | null): Promise<Reservation> {
    const now = this.o.now();
    const day = dayKey(now);
    return this.locked(day, async () => {
      const daySpent = sumOf(await this.read(day));
      if (limit !== null && (daySpent >= limit || daySpent + estimate > limit)) return { ok: false, daySpent };
      await this.append(day, `reserve ${this.o.session} ${requestId} ${fixed(estimate)} ${now}`);
      this.day.set(requestId, day);
      this.open.add(requestId);
      return { ok: true, daySpent };
    });
  }

  /** Returns the day's total after the commit. */
  async commit(requestId: string, actual: number): Promise<number> {
    return this.settle(requestId, `commit ${requestId} ${fixed(actual)}`);
  }

  async release(requestId: string): Promise<void> {
    await this.settle(requestId, `release ${requestId}`);
  }

  async releaseOutstanding(): Promise<void> {
    for (const id of [...this.open]) await this.release(id);
  }

  private async settle(requestId: string, line: string): Promise<number> {
    const day = this.day.get(requestId) ?? dayKey(this.o.now());
    return this.locked(day, async () => {
      await this.append(day, line);
      this.open.delete(requestId);
      this.day.delete(requestId);
      return sumOf(await this.read(day));
    });
  }
}
