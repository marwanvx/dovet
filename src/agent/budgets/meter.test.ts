import { describe, expect, test } from "bun:test";
import { BudgetMeter, type Limits } from "./meter.ts";

const NONE: Limits = { turn: null, session: null, day: null, tokens: null };
const est = (usd: number, tokens = 0): { usd: number; tokens: number } => ({ usd, tokens });

// spec: AC-RCPT-03
describe("budget meter", () => {
  test("pauses before a request whose estimate would pass the session limit, naming spent and estimate", () => {
    const m = new BudgetMeter({ ...NONE, session: 5 }, { sessionUsd: 4.71, sessionTokens: 0 });
    const stop = m.check(est(0.4));
    expect(stop?.scope).toBe("session");
    expect(stop?.message).toBe("Session budget $5.00 would be exceeded (spent $4.71, next request ≈ $0.40).");
    expect(m.check(est(0.29))).toBeNull();
  });

  test("no new request starts once spent reaches the limit, whatever the estimate", () => {
    const m = new BudgetMeter({ ...NONE, session: 1 }, { sessionUsd: 1, sessionTokens: 0 });
    expect(m.check(est(0))?.scope).toBe("session");
    expect(new BudgetMeter({ ...NONE, session: 0 }, { sessionUsd: 0, sessionTokens: 0 }).check(est(0))?.scope).toBe(
      "session",
    );
  });

  test("a limit of null never stops anything", () => {
    const m = new BudgetMeter(NONE, { sessionUsd: 1e9, sessionTokens: 1e12 });
    expect(m.check(est(1e9, 1e9))).toBeNull();
  });

  test("the turn limit counts only this turn and starts again with the next turn", () => {
    const m = new BudgetMeter({ ...NONE, turn: 1 }, { sessionUsd: 50, sessionTokens: 0 });
    m.record("main", 0.9, 0);
    expect(m.check(est(0.2))?.scope).toBe("turn");
    m.startTurn();
    expect(m.check(est(0.2))).toBeNull();
  });

  test("the token limit uses estimated tokens and stops on spent tokens", () => {
    const m = new BudgetMeter({ ...NONE, tokens: 10_000 }, { sessionUsd: 0, sessionTokens: 8000 });
    expect(m.check(est(0, 1999))).toBeNull();
    const stop = m.check(est(0, 2001));
    expect(stop?.scope).toBe("tokens");
    expect(stop?.message).toContain("Token budget 10,000");
  });

  test("the first scope that stops wins, in the order turn, session, tokens", () => {
    const m = new BudgetMeter({ turn: 1, session: 1, day: null, tokens: 1 }, { sessionUsd: 0, sessionTokens: 0 });
    m.record("main", 1, 1);
    expect(m.check(est(0, 0))?.scope).toBe("turn");
  });

  test("80% of a budget warns once per scope, then not again until the turn scope restarts", () => {
    const m = new BudgetMeter({ ...NONE, session: 10, turn: 1 }, { sessionUsd: 0, sessionTokens: 0 });
    m.record("main", 0.79, 100);
    expect(m.warnings(null)).toEqual([]);
    m.record("main", 0.02, 100);
    expect(m.warnings(null)).toEqual([{ kind: "warn", scope: "turn", spent: 0.81, limit: 1 }]);
    expect(m.warnings(null)).toEqual([]);
    m.record("main", 7.5, 100);
    expect(m.warnings(null).map((w) => w.scope)).toEqual(["session"]);
    m.startTurn();
    m.record("main", 0.85, 0);
    expect(m.warnings(null).map((w) => w.scope)).toEqual(["turn"]);
  });

  test("the day scope warns from the ledger's total", () => {
    const m = new BudgetMeter({ ...NONE, day: 10 }, { sessionUsd: 0, sessionTokens: 0 });
    expect(m.warnings(7.9)).toEqual([]);
    expect(m.warnings(8)).toEqual([{ kind: "warn", scope: "day", spent: 8, limit: 10 }]);
    expect(m.warnings(9)).toEqual([]);
  });

  test("spend is attributed by purpose", () => {
    const m = new BudgetMeter(NONE, { sessionUsd: 0, sessionTokens: 0 });
    m.record("main", 0.5, 10);
    m.record("compaction", 0.25, 5);
    m.record("main", 0.125, 1);
    expect(m.byPurpose()).toEqual({ main: 0.625, compaction: 0.25 });
    expect(m.sessionUsd).toBe(0.875);
    expect(m.sessionTokens).toBe(16);
  });
});

// spec: AC-RCPT-03
test("a refused day reservation reads like the other pauses", () => {
  const m = new BudgetMeter({ ...NONE, day: 10 }, { sessionUsd: 0, sessionTokens: 0 });
  expect(m.dayStop(9.5, 0.6).message).toBe(
    "Daily budget $10.00 would be exceeded (spent $9.50, next request ≈ $0.60).",
  );
});
