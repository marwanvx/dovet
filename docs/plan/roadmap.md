# Roadmap

This file orders the work; what each feature must do is in its spec (each spec's "Before you build" box names its milestone). Milestones are **evidence gates, not calendar dates**: each ends when its exit evidence exists. The order proves the core trust model on one end-to-end slice before widening providers and platforms. **Nothing is implemented yet; work starts at M0.** Build only the current milestone; v0.2 items are listed so v0.1 code leaves room for them, not to be built early.

## M0 — Risk burn-down

Resolve every **blocking M0** spike in [open-questions](open-questions.md): SPIKE-2 (install layout), SPIKE-4 (pi-tui core on all terminals), SPIKE-15 (WASM grammars in the compiled binary), SPIKE-16 (sandbox-runtime under a compiled host), SPIKE-22 + the filter-safety test (git snapshots), a first look at SPIKE-42 (Windows sandbox via MXC), plus the release pipeline: install-directory archives for all 8 targets, `.env`/`bunfig` autoload disabled (with its test), Ed25519-signed `SHA256SUMS`, GitHub artifact attestations, Actions pinned by SHA, generated `THIRD_PARTY_NOTICES`, the `dependency-cruiser` import-boundary check, Bun ≥ 1.4.3 with `bun check` in CI.

**Exit evidence:** on each OS the compiled binary parses with tree-sitter, runs the bundled `rg`, shows a pi-tui screen, runs a sandboxed `echo`, takes and restores a filter-safe snapshot; a signed release installs and self-updates in CI.

## M1 — Headless vertical slice (NVIDIA first)

Event log (core/optional events, inline epoch headers, GC invariant), config + secrets, the first provider: NVIDIA through `@ai-sdk/openai-compatible` (Chat Completions streaming, `reasoning_content`, tool calls; owner decision 2026-10-13, QUESTIONS Q23), transcript builder with epochs, the agent loop (all stop reasons, interrupts keeping completed blocks, signals), tools Read/Write/Edit/Bash (+PowerShell)/Grep/Glob with the shell snapshot, AskUserQuestion, TodoWrite, EnterPlanMode/ExitPlanMode (tool and Session-API side; the dialogs come with the TUI in M3), policy engine (rules, modes, read-only set, protected/critical paths, sensitive-file reads), headless `-p`.
**Adapter-contract proof (no live calls, no UI):** the generic AI SDK adapter runs the same contract tests with `@ai-sdk/openai-compatible` (Chat Completions, the format most other providers and local servers use, with `reasoning_content`; fixtures recorded live on NVIDIA), `@ai-sdk/openai` (Responses) and `@ai-sdk/google` (Gemini) against recorded fixtures (for the two without a key, fixtures written from each provider's documented stream format), including replay fidelity and the prefix property [SPIKE-44]. This proves the adapter and `Part` contracts fit three providers before code piles up on them. Any contract change it forces is an ADR in M1, not M4.
**No other provider work (streaming, live, presets) before this gate.**

**Exit evidence:** 10 real multi-turn coding tasks complete end-to-end headless on Linux; the adapter-contract proof passes for 3 protocols; scripted Session-API tests (permissions, questions, plan, interrupt) and the two-sessions-in-one-process test pass; byte-identical replay of their logs; the cache-read monitor works on recorded fixtures; the permission corpus passes; CI green on all three OSes for unit + platform tests.

## M2 — Safety and recoverability

Sandbox enforcement (auto-allow only with a healthy sandbox; degraded paths), taint, WebFetch/WebSearch, workspace trust, secret redaction incl. `.env` values, interruption/crash recovery, checkpoints and rewind, blob GC, budgets with the cross-session daily ledger, compaction.

**Exit evidence:** acceptance criteria of [permissions](../specs/permissions.md), [receipts-budgets](../specs/receipts-budgets.md) (budget part), [checkpoints](../specs/checkpoints.md), [context §6](../specs/context.md) pass; the adversarial eval tasks don't violate any guarantee in [permissions §0](../specs/permissions.md); kill -9 at random points never corrupts a session.

## M3 — Usable alpha

TUI ([tui](../specs/tui.md)), receipts and claim checker, plan-mode and question dialogs, `/login` and the first-run wizard with curated provider records ([cli-config](../specs/cli-config.md)), `/why`, `/context`, signed/attested releases on the install page. Primary OS for daily use: Linux; macOS and Windows kept green in CI with smoke tests throughout.

**Exit evidence:** the owner uses Dovet as their daily coding agent for two weeks; the claim checker's precision/recall are measured on labeled transcripts.

## M4 — Compatibility expansion

OpenAI Responses, Sign in with ChatGPT, generic provider records from models.dev (incl. China/international platforms and coding plans), Open Responses server profiles (OpenRouter, AI Gateway, Ollama, LM Studio, vLLM) after their conformance spike (SPIKE-21), Chat Completions fallback, model catalog/pricing rules, failover. **All providers at once, treated the same:** every models.dev provider is available through its generic record from M4 on; curated records add tested defaults, and a provider that needs something data can't express gets a provider module ([providers](../specs/providers.md)). There is no per-provider priority list. Native Windows sandbox stays **experimental** unless it passes the same escape test suite as Linux/macOS.

**Exit evidence:** all of [providers](../specs/providers.md)'s acceptance criteria; adapter contract tests pass for every protocol.

## M5 — v0.1 release

Eval suite on `@vercel/agent-eval` (40+ tasks incl. adversarial, with Claude Code and Codex baselines), per-family A/B of the shared tools and prompt (SPIKE-13), soak tests, docs.

**Exit evidence:** the release gates of [testing](../specs/testing.md).

---

## v0.2 (after v0.1 feedback)

MCP client (2026-07-28 spec) with deferred tool loading · skills and custom commands · hooks · subagents · ACP server · auto mode (a model reviews boundary crossings, [permissions §9](../specs/permissions.md)) · LSP diagnostics · background tasks and Monitor · NotebookEdit · auto memory · package-manager distribution · Windows signing via SignPath Foundation · Bedrock/Vertex/Foundry for Claude.

## v0.3 (candidates, decided by evals and user demand)

Code mode (QuickJS) · plugins · git worktree isolation for parallel sessions · provider-native compaction/context editing as opt-in options · team-shareable session exports.
