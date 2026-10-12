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
