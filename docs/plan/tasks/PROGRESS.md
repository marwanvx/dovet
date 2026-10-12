# Progress log

Append-only. One entry per session, newest last ([build loop](../../workflow/build-loop.md) step 9).

## 2026-10-12 — planning complete
Done: v0.1 specs, decisions, prompts and the M0 task list are written. No code exists yet.
Learned: the repository is created by task M0-01; everything before it lives in `docs/`.
Next: M0-01.

## 2026-10-12 — task lists for M1–M5 written
Done: 88 tasks across M0–M5; every acceptance criterion is placed in exactly one task's "Done when"; every task's reading list resolves with `scripts/next.py`.
Learned: each milestone's list is re-checked against what was actually built before its first task starts (build loop step 4).
Next: M0-01.

## 2026-10-12 — M0-01 Repository scaffold
Done: module tree, `bun run check` (type check, Biome, dependency-cruiser boundaries, tests, spec coverage, docs check), CI green on Linux/macOS/Windows, community files; docs scripts ported to `bun run next` / `docs:boxes` / `docs:check` (Python versions removed). PR: #1 (merged).
Learned: `typescript` is pinned to 6.0.3 because dependency-cruiser needs `<7` (Bun's own `bun check` does the type check). This session's GitHub integration gets 403 on Actions re-runs and branch protection: the three CI jobs are not yet required status checks on `main` (owner can add `check (ubuntu-latest)`, `check (macos-latest)`, `check (windows-latest)`). Dependabot uses the `bun` ecosystem as an assumption (QUESTIONS Q1). A `setup-bun` download can 504 on macOS; that's GitHub, not the code.
Next: M0-02.

## 2026-10-12 — M0-02 Compiled binary and safe compile flags
Done: `bun run build` compiles `src/cli/main.ts` (prints the version) into `dist/dovet` with `.env`/`bunfig.toml` autoload off; `compileDovet()` in `scripts/build.ts` holds the compile options; AC-ARCH-01 tested on all 3 OSes. PR: #2 (merged).
Learned: Bun 1.4.2's `bun check` runs the package's `check` script instead of type-checking, so `bun run check` recurses forever: use Bun ≥ 1.4.3 locally (CI pins 1.4.3). `dovet` can't spawn children yet, so the `.env`-in-child half of AC-ARCH-01 uses a probe compiled with the same options (`test/platform/compile-flags/env-probe.ts`). `scripts/build.ts` isn't in architecture "Repository layout" yet (only the `build` script is); add it with the next spec change.
Next: M0-03.

## 2026-10-12 — M0-03 SPIKE-15: tree-sitter grammars inside the binary
Done: `loadShellParsers()` (`src/policy/shell-parse/load.ts`, exported from `policy`) embeds the tree-sitter runtime and the Bash and PowerShell grammars in the compiled binary; a probe built with Dovet's compile options parses 10 Bash and 10 PowerShell commands on all 3 OSes, flags malformed ones, and loads every `.wasm` from the embedded filesystem. SPIKE-15 resolved: yes, no fallback. PR: #3 (merged).
Learned: import the `.wasm` files `with { type: "file" }` (typed by `src/policy/shell-parse/wasm.d.ts`) and pass the runtime's bytes as `wasmBinary`, or the compiled binary looks for `/$bunfs/root/web-tree-sitter.wasm` and fails. Call `loadShellParsers()` once per process (web-tree-sitter keeps one runtime instance); the caller owns the result. All three `.wasm` are ABI 15 (≈2.6 MB). For M1's 200 ms budget: 0.27.1 types `progressCallback` as returning `void` though its docs say `true` cancels. Local Bun must be ≥1.4.3 (`curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3`).
Next: M0-04.
