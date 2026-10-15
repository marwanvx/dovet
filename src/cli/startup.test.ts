// Headless startup helpers (cli-config "Startup sequence", "Piped input", "Data and privacy").
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spec: AC-CLI-13
describe("startup without network and with unreadable state", () => {
  test("inherited Dovet variables are ignored", async () => {
    const { filterInheritedEnv } = await import("./startup.ts");
    const { clean, ignored } = filterInheritedEnv({
      DOVET: "1",
      DOVET_RUN: "abc",
      DOVET_SNAPSHOT: "s",
      AI_AGENT: "x",
      KEEP: "yes",
    });
    expect(clean).toEqual({ KEEP: "yes" });
    expect([...ignored].sort()).toEqual(["AI_AGENT", "DOVET", "DOVET_RUN", "DOVET_SNAPSHOT"]);
  });

  test("a corrupt trusted-folders.json is backed up and rebuilt", async () => {
    const { loadTrustedFolders } = await import("./startup.ts");
    const dir = mkdtempSync(join(tmpdir(), "dovet-trust-"));
    writeFileSync(join(dir, "trusted-folders.json"), "{ not json", "utf8");
    const r = await loadTrustedFolders(dir, 1_700_000_000_000);
    expect(r.warning).toMatch(/backed up/);
    expect(r.backedUp ?? "").toMatch(/\.corrupt-/);
    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(r.backedUp ?? "")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "trusted-folders.json"), "utf8"))).toEqual({});
  });

  test("a read-only data dir starts with a no-save notice", async () => {
    const { ensureDataDir } = await import("./startup.ts");
    const dir = mkdtempSync(join(tmpdir(), "dovet-ro-"));
    const file = join(dir, "file");
    writeFileSync(file, "x", "utf8");
    const r = await ensureDataDir(file);
    expect(r.writable).toBe(false);
    expect(r.notice ?? "").toMatch(/won't be saved/);
  });
});

// spec: AC-CLI-19
describe("offline mode", () => {
  test("offline refuses WebFetch and WebSearch with a clear message", async () => {
    const { offlineRefusal } = await import("./startup.ts");
    expect(offlineRefusal("WebFetch")).toMatch(/--offline/);
    expect(offlineRefusal("WebSearch")).toMatch(/--offline/);
  });
});
