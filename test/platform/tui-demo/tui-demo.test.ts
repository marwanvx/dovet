// SPIKE-4 (docs/plan/open-questions.md): the vendored pi-tui core runs inside a compiled binary without its native
// addons. No acceptance criterion yet (the TUI criteria are M3); the real-terminal results come from the owner's
// checklist. This test proves the part a machine can: the compiled `tui-demo` renders streaming markdown, the editor
// and an overlay through pi-tui's real inline renderer, and nothing in the vendored copy loads a `.node` addon.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTuiDemo } from "../../../scripts/tui-demo.ts";

const EXE = process.platform === "win32" ? ".exe" : "";
const VENDOR = join(import.meta.dir, "..", "..", "..", "src", "tui", "vendor", "pi-tui");
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dovet-tui-demo-"));
  await compileTuiDemo({ outfile: join(dir, `tui-demo${EXE}`) });
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("compiled tui-demo", () => {
  test("--self-test renders the streamed reply, the editor and the overlay through the inline renderer", () => {
    const r = Bun.spawnSync([join(dir, `tui-demo${EXE}`), "--self-test"], { stdin: "ignore" });
    const out = r.stdout.toString();
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    // The streamed markdown arrived complete: heading, table cells, code and wide characters.
    expect(out).toContain("Streaming markdown");
    expect(out).toMatch(/│\s*Terminal\s*│/);
    expect(out).toContain("const greeting");
    expect(out).toContain("日本語");
    // The editor's border and the overlay's text are on screen.
    expect(out).toContain("typed into the editor");
    expect(out).toContain("This is an overlay");
    // pi-tui's inline renderer wrapped its frames in synchronized output (mode 2026).
    expect(out).toContain("frames synchronized: yes");
  });

  test.if(process.platform === "win32")(
    "Windows: the kernel32 console-mode call loads and runs without the addon",
    () => {
      // stdin is not a console in the test, so GetConsoleMode fails and the call reports false instead of throwing.
      const r = Bun.spawnSync([join(dir, `tui-demo${EXE}`), "--self-test"], { stdin: "ignore" });
      expect(r.stderr.toString()).toBe("");
      expect(r.stdout.toString()).toContain("vt input enabled: false");
    },
  );
});

describe("vendored pi-tui", () => {
  const files = readdirSync(VENDOR, { recursive: true, encoding: "utf8" });

  test("keeps its MIT license notice", () => {
    const license = readFileSync(join(VENDOR, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2025 Mario Zechner");
  });

  test("contains no native addon and no code that loads one", () => {
    expect(files.filter((f) => f.endsWith(".node"))).toEqual([]);
    // Any addon or FFI loader, except windows-console.ts (Dovet's kernel32 call, VENDORED.md).
    const loaders = files
      .filter((f) => f.endsWith(".ts") && !f.endsWith("windows-console.ts"))
      .filter((f) =>
        /createRequire|\brequire\(|process\.dlopen|\bdlopen\(|bun:ffi|\.node["'`]|native-platform|native-modifiers/.test(
          readFileSync(join(VENDOR, f), "utf8"),
        ),
      );
    expect(loaders).toEqual([]);
  });
});
