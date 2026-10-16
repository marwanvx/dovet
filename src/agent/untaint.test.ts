// M2-02 /untaint (permissions §10): AC-PERM-27 requires confirmation and logging.
import { describe, expect, test } from "bun:test";
import { SessionImpl } from "./session.ts";

// spec: AC-PERM-27
describe("/untaint", () => {
  test("requires confirmation, clears taint and logs a notice", async () => {
    const session = new SessionImpl(
      {
        clock: { now: () => 0 },
        ids: { ulid: () => "01J0000000000000000000000" as never },
        platform: {} as never,
        dirs: { config: "/c" as never, data: "/d" as never, cache: "/q" as never },
        env: {},
        stdio: { isTTY: false },
      },
      { cwd: "/w" as never, interactive: false, overrides: {} },
    );
    session.applyEffects([{ kind: "taint", source: "sandbox: example.com" }]);
    expect(session.toolContext().session.taint).toEqual(["sandbox: example.com"]);
    const need = await session.command({ name: "untaint", args: "" });
    expect(need.ok).toBe(false);
    expect(need.ok === false && need.error).toContain("confirm");
    expect(session.toolContext().session.taint).toEqual(["sandbox: example.com"]);
    const iter = session.events()[Symbol.asyncIterator]();
    await iter.next();
    const pending = iter.next();
    const done = await session.command({ name: "untaint", args: "confirm" });
    expect(done.ok).toBe(true);
    expect(done.ok === true && done.output).toContain("untainted");
    expect(session.toolContext().session.taint).toEqual([]);
    const logged = await pending;
    expect(JSON.stringify(logged.value ?? {})).toContain("untainted");
    await session.close();
  });
});
