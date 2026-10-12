# Principles

Every design and code decision follows these. When two conflict, the lower number wins.

## Product principles

1. **Never lie, never hide.** The user can always find out what model ran, with what parameters, what it was told, what it did, and what it cost. No silent fallbacks, silent model switches, or silent default changes.
2. **Safe by default, fast by choice.** The sandbox is on and risky actions ask, unless the user explicitly opts out. Opting out is visible in the status bar for the whole session.
3. **The user's money is sacred.** Never spend tokens the user didn't ask for. Background calls (summaries, titles, classifiers) are off by default, or shown and counted when on.
4. **Compatible beats novel.** Read the formats people already use (AGENTS.md, CLAUDE.md, SKILL.md, `.mcp.json`, Claude Code permission syntax). Switching to Dovet should cost nothing.

## Engineering principles

5. **Append-only everything.** The event log is append-only. The conversation sent to the model is append-only within an epoch (see [specs/context.md](../specs/context.md)). This is *required* by current Anthropic models: editing earlier turns invalidates the model's reasoning blocks (400 errors on accounts created on or after 2026-08-31) and breaks the prompt cache [VERIFIED 2026-10-10, Anthropic API docs]. It is also what makes receipts and rewind possible.
6. **The model is untrusted input.** Tool arguments, paths and commands from the model are validated, canonicalized and permission-checked before execution. So is content from the web, files and MCP servers.
7. **Deterministic prompt assembly.** The same inputs produce byte-identical requests. No timestamps, random IDs or unsorted maps in the prompt prefix. This is tested, not hoped for.
8. **Thin harness.** Every feature must be removable in about an hour. Behavior that stronger models make unnecessary gets deleted. Domain knowledge goes in prompts and skills, not code.
9. **Rules in code, not prose.** If a rule can be checked mechanically (a path, a command, a budget), it is enforced by the harness. The prompt may also mention it, but the prompt is never the only guard.
10. **One way to do each thing.** No parallel implementations, no "legacy path" kept "just in case".
11. **Fail loudly and specifically.** Errors name the cause and the fix. No catch-and-ignore. Tool errors go back to the model as `is_error` results with actionable text.
12. **Cross-platform from day one.** Every feature is specified for Windows, macOS and Linux before it's built. "Linux-only for now" needs an ADR.
13. **Use maintained packages; write only what's ours.** When a well-maintained package meets a requirement (the AI SDK for providers, ripgrep for search), use it instead of writing our own; Dovet's own code is its core: the agent loop, safety, transparency and UI. Every runtime dependency has an entry in ADR-15. Small, critical libraries from single maintainers are vendored. Native modules are avoided unless an ADR justifies one.
14. **Measure, don't assume.** Prompt, tool and default changes are justified by eval results ([specs/testing.md](../specs/testing.md)), not intuition.

## Code-quality rules (enforced in CI)

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No `any` (lint error). `unknown` plus a zod parse at every boundary.
- Every external input (API responses, config files, tool arguments, MCP messages, event-log lines) is parsed with a zod schema before use.
- No floating promises (lint rule). Every async operation is awaited, or explicitly tracked and cancellable with an `AbortSignal`.
- Package boundaries are enforced by a dependency-direction check ([specs/architecture.md](../specs/architecture.md)).
- No module-level mutable state, no `process.chdir`, no writes to `process.env`; only `cli/main.ts` touches `process.*` ([interfaces §9](../specs/interfaces.md), ADR-26).
- No new abstraction until there are three real uses.
- Public functions in `agent`, `ai`, `policy` and `store` have unit tests. Every bug fix adds a regression test.
