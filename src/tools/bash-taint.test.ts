// M2-02 taint from sandboxed network (permissions §10): AC-PERM-27 trigger through the Bash tool.
import { describe, expect, test } from "bun:test";
import { fakeSandboxService } from "../policy/index.ts";
import { Settings } from "../schema/index.ts";
import { createBashTool, createToolRegistry } from "./index.ts";
import { context, workspace } from "./test-context.ts";
import type { ToolContext } from "./types.ts";

// spec: AC-PERM-27
describe("sandboxed curl to a non-registry host taints", () => {
  test("curl shape to example.com emits taint; registry does not; blocked host does not", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const tmp = await workspace();
    const base = context(cwd);
    const ctxFor = (violations: string[]): ToolContext => ({
      ...base,
      env: { PATH: process.env.PATH ?? "", HOME: cwd },
      settings: Settings.parse({}),
      sandbox: fakeSandboxService("on", "bubblewrap", violations, tmp),
      platform: { ...base.platform, shells: () => ({}) },
    });
    const tool = createBashTool({ tmpDir: tmp });
    const run = async (ctx: ToolContext, command: string) => {
      const prepared = createToolRegistry([tool]).prepare("Bash", { command });
      if (!prepared.ok) throw new Error(prepared.message);
      return tool.run(prepared.input as never, ctx);
    };
    // The taint heuristic reads hosts from the command text (proxy allow log is the future source);
    // `echo` keeps the test offline while proving the wiring from text to taint effect.
    const tainted = await run(ctxFor([]), "echo curl https://example.com/x");
    expect(tainted.meta?.effects?.some((e) => e.kind === "taint")).toBe(true);
    const clean = await run(ctxFor([]), "echo curl https://registry.npmjs.org/a");
    expect(clean.meta?.effects ?? []).toEqual([]);
    const blocked = await run(
      ctxFor(["blocked host: example.com (denied by sandbox)"]),
      "echo curl https://example.com/x",
    );
    expect(blocked.meta?.effects ?? []).toEqual([]);
  });
});
