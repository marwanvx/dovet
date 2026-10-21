// Budget scopes, the 80% warning and the stop before a request (receipts-budgets "Budget scopes" and "Behavior").
export type Scope = "turn" | "session" | "day" | "tokens";
export type Limits = { turn: number | null; session: number | null; day: number | null; tokens: number | null };
export type BudgetEvent = { kind: "warn"; scope: Scope; spent: number; limit: number };
export type Stop = { scope: Scope; spent: number; limit: number; estimate: number; message: string };

const WARN_AT = 0.8;

const usd = (n: number): string => `$${n.toFixed(2)}`;

export class BudgetMeter {
  sessionUsd: number;
  sessionTokens: number;
  private turnUsd = 0;
  private readonly purposes = new Map<string, number>();
  private readonly warned = new Set<Scope>();

  constructor(
    public limits: Limits,
    start: { sessionUsd: number; sessionTokens: number },
  ) {
    this.sessionUsd = start.sessionUsd;
    this.sessionTokens = start.sessionTokens;
  }

  startTurn(): void {
    this.turnUsd = 0;
    this.warned.delete("turn");
  }

  record(purpose: string, spentUsd: number, tokens: number): void {
    this.turnUsd += spentUsd;
    this.sessionUsd += spentUsd;
    this.sessionTokens += tokens;
    this.purposes.set(purpose, (this.purposes.get(purpose) ?? 0) + spentUsd);
  }

  byPurpose(): Record<string, number> {
    return Object.fromEntries(this.purposes);
  }

  /** The turn, session and token scopes; the day scope is the ledger's, which sums every session. */
  check(estimate: { usd: number; tokens: number }): Stop | null {
    const { turn, session, tokens } = this.limits;
    if (turn !== null && exceeds(this.turnUsd, estimate.usd, turn))
      return stop("turn", this.turnUsd, turn, estimate.usd, `Turn budget ${usd(turn)}`, usd);
    if (session !== null && exceeds(this.sessionUsd, estimate.usd, session))
      return stop("session", this.sessionUsd, session, estimate.usd, `Session budget ${usd(session)}`, usd);
    if (tokens !== null && exceeds(this.sessionTokens, estimate.tokens, tokens))
      return stop("tokens", this.sessionTokens, tokens, estimate.tokens, `Token budget ${count(tokens)}`, count);
    return null;
  }

  /** What the ledger refused: the day's total across sessions plus this request would pass `budget.daily`. */
  dayStop(spent: number, estimateUsd: number): Stop {
    return stop("day", spent, this.limits.day ?? 0, estimateUsd, `Daily budget ${usd(this.limits.day ?? 0)}`, usd);
  }

  /** Scopes that crossed 80% since the last call; each warns once (the turn scope again in the next turn). */
  warnings(daySpent: number | null): BudgetEvent[] {
    const { turn, session, day, tokens } = this.limits;
    const out: BudgetEvent[] = [];
    const note = (scope: Scope, spent: number, limit: number | null): void => {
      if (limit === null || this.warned.has(scope) || spent < limit * WARN_AT) return;
      this.warned.add(scope);
      out.push({ kind: "warn", scope, spent, limit });
    };
    note("turn", this.turnUsd, turn);
    note("session", this.sessionUsd, session);
    note("tokens", this.sessionTokens, tokens);
    if (daySpent !== null) note("day", daySpent, day);
    return out;
  }
}

function exceeds(spent: number, estimate: number, limit: number): boolean {
  return spent >= limit || spent + estimate > limit;
}

const count = (n: number): string => Math.round(n).toLocaleString("en-US");

function stop(
  scope: Scope,
  spent: number,
  limit: number,
  estimate: number,
  name: string,
  fmt: (n: number) => string,
): Stop {
  const next = scope === "tokens" ? `next request ≈ ${fmt(estimate)} tokens` : `next request ≈ ${fmt(estimate)}`;
  return { scope, spent, limit, estimate, message: `${name} would be exceeded (spent ${fmt(spent)}, ${next}).` };
}
