export function fakeClock(start = 0): { now(): number; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}
