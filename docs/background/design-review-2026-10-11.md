# Design Review (2026-10-11)

> **Background, not a spec.** Written while the product's codename was "Glass"; it is now **Dovet**. This file records research and history: what was checked, where, and why decisions were made. It may describe earlier states of the plan. The specs (00–19, 21, 23, prompts/) are the source of truth; if this file disagrees with them, the spec wins.

A full pass over every spec: facts re-verified against current official documentation (Context7 for library and SDK docs; official doc sites for Claude Code, Google, OpenAI), and each design questioned against alternatives. This file records what was checked, what changed, and why. The specs themselves have already been updated; ADRs 16–24 record the decisions.

## 1. Verified facts that changed the design

| # | Finding | Source | Impact |
|---|---|---|---|
| F1 | **Compiled Bun executables auto-load `.env` and `bunfig.toml` from the current directory by default.** | Bun 1.4 docs (`autoloadDotenv` default `true`) | **Security bug in the old plan:** Glass would have loaded every project's secrets into its own environment. Build now disables both, with a CI test. ([architecture](../specs/architecture.md), ADR-1) |
| F2 | Files embedded in a compiled Bun binary live under `/$bunfs/`; JS can read them, the OS can't execute them. | Bun docs | `rg` can't be embedded and executed. → install-directory layout. (ADR-20) |
| F3 | sandbox-runtime finds its helpers (seccomp filters, `srt-win.exe`, Java agent) relative to its own files, accepts explicit paths, and warns helpers must sit outside sandbox write grants. | Package source (v0.0.79) | Ship helpers in `libexec/srt/`, pass explicit paths. (ADR-6, ADR-20) |
| F4 | `tree-sitter-bash` / `tree-sitter-powershell` npm packages are native addons, **but also ship `.wasm` grammars**. | npm tarballs | Use the `.wasm` files with `web-tree-sitter`; never install the native builds. ([architecture](../specs/architecture.md), SPIKE-15) |
| F5 | pi-tui ships optional native addons (clipboard, modifiers) for each OS. | npm tarball, README | Vendor only the TS core. Its inline renderer clears scrollback on changes above the viewport → "append-only screen" rule. (ADR-5, [tui](../specs/tui.md)) |
| F6 | Claude Code's permission system: modes `default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions`; detailed rule grammar; protected and critical paths; **sandbox auto-allow on by default** (sandboxed commands run without prompts); unsandboxed retry escape hatch; workspace trust. | code.claude.com permissions, permission-modes, sandboxing pages | Owner asked for Claude Code's behavior → [permissions](../specs/permissions.md) rewritten for parity. (ADR-18) |
| F7 | Claude Code runs **unsandboxed on native Windows** (recommends WSL2). | Claude Code sandboxing docs | Glass's Windows sandbox stays an opt-in alpha; without it, Windows behaves like Claude Code. |
| F8 | OpenAI Responses: `encrypted_content` returned by default with `store: false`; `reasoning.context: "all_turns"`; assistant `phase` must be preserved to avoid early stopping; `toResponseInputItems` helper; explicit cache breakpoints on GPT-5.6+; `prompt_cache_retention: "24h"`; native `shell` tool. | OpenAI docs via Context7 | Adapter spec updated; gpt profile uses native `shell` + `apply_patch`. ([providers](../specs/providers.md)) |
| F9 | **Open Responses**: vendor-neutral spec of the Responses API, supported by OpenRouter, Vercel AI Gateway, Ollama, LM Studio, vLLM, Hugging Face. | openresponses.org, InfoQ, Simon Willison | One adapter for OpenAI + aggregators + local runtimes; Chat Completions demoted to fallback. (ADR-16) |
| F10 | Google's **Interactions API** is the recommended interface for new projects; `generateContent` still fully supported; stateless replay (`store: false`) with thought signatures works. | Google blog, @google/genai docs, OpenCode's `@opencode/ai` README | Gemini adapter targets Interactions. (ADR-17) |
| F11 | MCP TypeScript SDK v2 split into `@modelcontextprotocol/client`, which negotiates modern (2026-07-28) and legacy servers automatically. | MCP SDK docs via Context7 | SPIKE-9 resolved; lighter dependency. ([extensibility](../specs/extensibility.md)) |
| F12 | The Anthropic SDK's tool runner offers `runToolsEagerly`; tool definitions accept `input_examples`, `defer_loading`, `strict`, `eager_input_streaming`. | Anthropic TS SDK docs via Context7 | Early execution of read-only tools. (ADR-21) |
| F13 | Bun 1.4 targets include windows-arm64 and linux musl; `Bun.spawn` has `detached` (setsid), built-in PTY (`terminal`, ConPTY on Windows), `timeout`, `killSignal`. | Bun docs + types | SPIKE-3 resolved; no node-pty needed for v0.2 interactive commands. ([platforms](../specs/platforms.md)) |
| F14 | ~~OpenCode replaced most of its Vercel AI SDK use with its own provider layer~~ **Corrected (external review):** OpenCode still uses the AI SDK by default; its native `@opencode/ai` runtime exists but is not the default. | OpenCode docs + repo | ADR-2 now rests on Glass's own fidelity requirements, with a maintenance-cost tripwire. |
| F15 | Vercel AI Gateway exposes Anthropic Messages, Open Responses and Chat Completions endpoints, with provider routing options. | Vercel docs via Context7 | Added as a provider preset with pinned routing. (ADR-24) |
| F16 | `zod` 4's `z.toJSONSchema` emits `additionalProperties: false` for objects in output mode; `io: "input"` keeps defaulted fields optional. | zod docs via Context7 | Tool schemas: `z.strictObject` + `io: "input"` (defaults stay optional, extra keys still rejected). |

## 2. Design challenges and outcomes

| Area | Question asked | Outcome |
|---|---|---|
| Distribution | Is a single-file binary the best form? | No: install directory with `libexec/`, versioned with rollback (F2, F3). |
| Repo structure | Are 10 workspace packages worth it for a solo developer? | No: one package with enforced import boundaries. (ADR-22) |
| Process model | Can one event loop keep the TUI responsive? | Probably; measured target (p99 < 16 ms echo) with a worker-ready boundary as the escape hatch. ([architecture](../specs/architecture.md)) |
| Storage | Do we need SQLite? | No: JSONL + disposable metadata sidecars. Raw provider output stored once. (ADR-4) |
| Resume correctness | Does resume after an upgrade keep the prompt prefix identical? | It didn't: the old spec re-rendered templates. Now each epoch stores the exact bytes. ([event-log](../specs/event-log.md)) |
| Session lock | PID-liveness checks across OSes? | Replaced with exclusive-create + mtime heartbeat. ([event-log](../specs/event-log.md)) |
| Effort changes | Do they need a new epoch? | No: parameters outside system/tools/messages don't invalidate reasoning; only one cache rewrite. ([context](../specs/context.md)) |
| Permissions | Ask-first, sandbox-first, or Claude Code parity? | Claude Code parity, which is itself sandbox-first via auto-allow. (ADR-18) |
| Checkpoints | Are tool-only checkpoints enough once shell edits run without prompts? | No: git tree snapshots in a private object store cover shell changes. (ADR-19) |
| Change detection | Two `git status` runs per command on big repos? | Replaced by incremental snapshots, skipped for read-only commands, auto-disabled above 2 s. ([tools](../specs/tools.md)) |
| Turn latency | Wait for the whole response before running tools? | No: start auto-allowed reads early. (ADR-21) |
| Providers | Four bespoke adapters, or a framework? | Own adapters (fidelity requirements; see corrected F14), but Open Responses makes one of them cover most providers. (ADR-16) |
| Gemini | Old API or new? | Interactions API, gated by SPIKE-19. (ADR-17) |
| Fork Pi? | Would forking a minimal harness save months? | No; borrow ideas and tests instead. (ADR-23) |
| Vercel ecosystem | Is anything from Vercel worth adopting? | AI Gateway preset and skills compatibility yes; AI SDK core no. (ADR-24) |
| Read output format | Arrow separator vs tab? | Tab (`cat -n` shape), matching what Claude models are trained on; eval knob. ([tools](../specs/tools.md)) |
| TUI expansion | Expand old tool output in place? | No: in inline mode that clears scrollback. Transcript viewer instead. ([tui](../specs/tui.md)) |

## 3. Things checked and left unchanged

- Append-only epochs and simple compaction (confirmed by Anthropic's preserved-thinking rules and OpenCode's Interactions default).
- Exact-match Edit tool; per-model edit dialects.
- Taint as a cheap prompt-injection layer while there is no classifier (Claude Code relies on its auto-mode classifier instead; Glass's auto mode arrives in v0.2).
- models.dev as the pricing catalog, with a bundled snapshot.
- Receipts and the claim checker (deterministic; no model calls).

## 4. Remaining risk, honestly stated

The highest-risk unknowns are now all M0 spikes (2, 4, 15, 16): whether the install layout, pi-tui's core, the WASM grammars and sandbox-runtime all work inside a Bun-compiled host on Windows, macOS and Linux. Each has a written fallback in [open-questions](../plan/open-questions.md). No feature work should start before they're resolved.

## Sources (this review)
- Bun executables and child-process docs (v1.4.2), via Context7: github.com/oven-sh/bun/blob/bun-v1.4.2/docs/bundler/executables.mdx
- Anthropic TypeScript SDK helpers and types, via Context7: github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md
- OpenAI docs, via Context7: developers.openai.com (reasoning, prompt caching, apply_patch, shell, local shell)
- Google Gen AI JS SDK docs, via Context7: googleapis.github.io/js-genai
- MCP TypeScript SDK docs, via Context7: github.com/modelcontextprotocol/typescript-sdk (docs/migration/support-2026-07-28.md)
- zod v4.6.5 JSON Schema docs, via Context7
- Vercel AI Gateway docs, via Context7: vercel.com/docs/ai-gateway
- Claude Code docs: code.claude.com/docs/en/permissions, /permission-modes, /sandboxing
- Google: blog.google/innovation-and-ai/technology/developers-tools/interactions-api-general-availability
- Open Responses: openresponses.org/changelog; infoq.com/news/2026/02/openai-open-responses; simonwillison.net/2026/Jan/15/open-responses
- OpenCode repo: github.com/sst/opencode (packages/core, packages/ai)
- Vercel: vercel.com/changelog/ai-sdk-7; infoq.com/news/2026/04/vercel-open-agents
- npm registry tarballs: @anthropic-ai/sandbox-runtime 0.0.79, tree-sitter-bash 0.25.1, tree-sitter-powershell 0.26.4, @earendil-works/pi-tui 1.1.0

---

## Second pass (same day): completeness audit

Method: every spec checked against a fixed checklist (inputs, outputs, state, errors, edge cases, concurrency, cross-platform, security, limits, UI, config, tests), plus a feature-by-feature comparison with Claude Code's tools reference, interactive-mode and memory docs [VERIFIED 2026-10-11], plus Bun/Anthropic SDK docs via Context7.

| Gap found | Fix | Where |
|---|---|---|
| Tool behaviors differed from Claude Code in ~12 places (output limits, failure excerpts, benign exit codes, read limits in tokens, PARTIAL views, PDFs/notebooks, Glob ignoring .gitignore with a 100 cap, Grep offset/count totals) | Tools spec rewritten | [tools](../specs/tools.md) |
| Edit/Write staleness too strict → read-again loops wasting tokens | Relaxed rule: apply when `old_string` matches current content exactly; shell views count as reads | [tools §3](../specs/tools.md) |
| Edit's lossy decode of legacy encodings could corrupt files; the whitespace-normalizing fallback differed from Claude Code | Refuse non-UTF-8 edits; strict matching only | [tools §3](../specs/tools.md) |
| Shell commands lacked the user's PATH/aliases (nvm, pyenv, conda) | Shell environment snapshot | [tools §5](../specs/tools.md), SPIKE-24 |
| No WebSearch; no plan approval flow | WebSearch via provider server tools; EnterPlanMode/ExitPlanMode | [tools §10–11](../specs/tools.md) |
| WebFetch lacked intranet refusal, cache, deadline, paging | Added (and kept Glass's no-extra-model-call design) | [tools §9](../specs/tools.md) |
| Interrupt discarded completed work | Keep completed blocks, as Claude Code does | [agent-loop](../specs/agent-loop.md) |
| No stream stall detection, no signal/crash handling, no terminal restore | Idle timeout, signal table, crash reports | [agent-loop](../specs/agent-loop.md) |
| Instruction loading differed (root-to-cwd walk, `.claude/rules` with `paths:`, 4-hop imports, external-import approval, comment stripping, no truncation, reload after compaction) | Rewritten for parity; AGENTS.md first-class | [context §3](../specs/context.md) |
| Missing input modes and keys (`!` shell mode, image paste, Ctrl+G/R/S/Z, Esc Esc, `?`), live command output, notifications, `/context` `/status` `/config` `/add-dir` `/plan` `/copy` | Added | [tui](../specs/tui.md) |
| No corporate proxy / custom CA support; no exact request-byte capture | Transport section | [providers §6b](../specs/providers.md) |
| Two sessions in one project would share a snapshot index | Per-session index seeded from the last one; worktrees and submodules specified | [checkpoints](../specs/checkpoints.md) |
| Module contracts were prose only | Normative TypeScript interfaces, full settings and env-var reference | [interfaces](../specs/interfaces.md) |
| The actual prompts didn't exist | Drafts for system prompts, every tool description, compaction, fixed instructions, `/init` | [prompts/](../prompts/README.md) |
| v0.2 features missing from the plan: LSP diagnostics, background tasks/Monitor, NotebookEdit, custom commands, full hook event list, auto memory | Specified with the v0.1 constraints they impose | [extensibility](../specs/extensibility.md), [context](../specs/context.md) |
| Update checks and session deletion unspecified | `updates.check`, `glass update --rollback`, `glass sessions delete` | [cli-config](../specs/cli-config.md) |

New spikes: SPIKE-24 to SPIKE-28.

---

## Third pass: external audit (glass-plan-audit-2026-10-11.md)

Every finding was verified independently before acting on it.

| # | Finding | Verdict | Evidence | Fix |
|---|---|---|---|---|
| 1 | `git add` in snapshots runs repository/user-configured clean/process filters | **Correct, P0** | git-scm.com gitattributes: clean filters run on check-in; process filters run "for the entire life of … `git add --all`"; `ident`, `eol`, `working-tree-encoding` also apply | Filter-free plumbing only; restore via `cat-file`, never `checkout`; filter-safety test ([checkpoints](../specs/checkpoints.md), ADR-19) |
| 2 | SHA-256 over the same channel isn't authenticity | **Correct** | Standard supply-chain reasoning | Ed25519-signed `SHA256SUMS` verified by installer and `glass update`; GitHub artifact attestations; Actions pinned by SHA ([architecture](../specs/architecture.md)) |
| 3 | Credential protection didn't cover Glass's own Read/Grep | **Correct** (introduced by the parity rewrite) | [permissions](../specs/permissions.md) §1 auto-approves working-dir reads; §7.2 list was sandbox-only | Sensitive-file policy for built-in tools; Grep/Glob skip; `.env` values redacted ([permissions §4.7](../specs/permissions.md)) |
| 4 | Blob GC could break resume of retained sessions | **Correct** | [event-log](../specs/event-log.md) GC rule vs epoch-header blobs | Epoch headers inline in the log; essential vs rewind-only blobs; GC traces all retained logs |
| 5 | Daily budget racy across concurrent sessions | **Correct** | Sidecar sums are read without coordination | Locked per-day reservation ledger; hard across sessions on one machine ([receipts-budgets](../specs/receipts-budgets.md)) |
| 6 | Skipping unknown events can misrepresent security state | **Correct** | [event-log](../specs/event-log.md) skipped all unknown types | Core vs optional events; unknown core → read-only with reason |
| 7 | Threat model under-specified | **Correct** | Taint covered only web/MCP | Explicit threat model with guarantees and non-guarantees; adversarial evals ([permissions §0](../specs/permissions.md), [testing](../specs/testing.md)) |
| 8 | Degraded sandbox must not keep auto-allow | **Already specified, made explicit** | [permissions §7.6](../specs/permissions.md) routed degraded commands to normal flow | Stated as an invariant; Windows labeled experimental; `failIfUnavailable` default for auto mode |
| 9 | Roadmap calendar optimistic; build a vertical slice first | **Agree** | 4 protocols + 3 OSes + sandbox + TUI in ~14 weeks for one developer | Evidence-gated roadmap; Anthropic-only headless slice first ([roadmap](../plan/roadmap.md)) |
| 10 | OpenCode evidence for ADR-2 overstated | **Correct — my error** | OpenCode docs: "OpenCode uses the AI SDK … to support 75+ LLM providers"; `@opencode/ai` exists but isn't the default | ADR-2 rewritten on Glass's own requirements, with a maintenance-cost tripwire; F14 corrected |
| 11 | OpenAI cache fields differ by model generation | **Correct** | OpenAI API reference: `prompt_cache_retention` deprecated, use `prompt_cache_options.ttl` (`"30m"` only) on GPT-5.6+ | Three capability-driven caching profiles with fixtures ([providers §4](../specs/providers.md)) |
| 12 | Use Bun 1.4.3's `bun check` | **Correct** | Bun v1.4.3 release notes (2026-10-10) | Min Bun 1.4.3; `bun check` + `bun test --check` in CI (ADR-1) |
| 13 | Stale ADR-4 title / "index" wording | **Correct** | ADR-4 still said "SQLite index" | Renamed; roadmap wording fixed |
| 14 | Receipts must not over-claim | **Agree** | Regex can't prove semantic claims | Precision and recall measured and published; "not verified by the log" wording ([receipts-budgets](../specs/receipts-budgets.md)) |

**Extra finding while verifying #12:** Bun ships `Bun.secrets` (OS keychain: macOS Keychain, Windows Credential Manager, Linux libsecret), so the native `@napi-rs/keyring` dependency is dropped (ADR-15, SPIKE-5).

---

## Fourth pass: full read-through and lifecycle walkthrough

Method: every spec re-read end to end after all edits, checking cross-references and stale values; then the product lifecycle walked step by step (install → first run → session → failure → upgrade → uninstall), checking each step is specified.

| Gap | Fix |
|---|---|
| Session API in 02 disagreed with the 21 contract; "normalized" response persisted; Windows "job object"; stale "index" in 06; outdated `checkpoint` and `permission.decision` event fields; daily spend still pointing at sidecars | Corrected ([architecture](../specs/architecture.md), [event-log](../specs/event-log.md), [agent-loop](../specs/agent-loop.md)) |
| 1 MB event guard broke large Write calls | Large string fields moved to essential blobs transparently ([event-log](../specs/event-log.md)) |
| Session data (code, output) had no file-permission rule | 0700/0600 on POSIX, user-only ACL on Windows ([event-log](../specs/event-log.md)) |
| 05 contradicted 07 (PDFs, web search) and duplicated outdated type definitions | 05 now defers to [interfaces](../specs/interfaces.md); server web search specified |
| No effort mapping across providers | Mapping table, nearest-lower rule, shown in status bar ([providers §2](../specs/providers.md)) |
| Compaction's summary request could have been appended to the epoch (breaking undo) | Explicitly a fork, never appended ([context §6](../specs/context.md)) |
| Images ignored in context estimates | Per-image token estimate ([context §6](../specs/context.md)) |
| Google cost formula used the old API's fields; server-tool fees missing | Updated ([receipts-budgets](../specs/receipts-budgets.md)) |
| Receipt had no data schema | `Receipt` type ([interfaces §6b](../specs/interfaces.md)) |
| "Workspace root", "working directory", `useGitRoot` used inconsistently | Two defined concepts: working directories vs project root ([cli-config](../specs/cli-config.md)) |
| Example config still used Chat Completions for Ollama/OpenRouter; `webfetch.allowPrivate` contradicted 07 | Fixed |
| Unspecified lifecycle steps: startup order, first run without a TTY, settings migration, install/PATH (Windows symlink limits), uninstall, piped stdin, bug-report bundle | Specified ([cli-config](../specs/cli-config.md)) |
| Accessibility not considered | Reduced motion, symbols alongside colors, plain renderer ([tui](../specs/tui.md)) |
| Acceptance criteria had no stable IDs, so "every criterion has a test" was uncheckable | 116 criteria now carry permanent `AC-<doc>-<n>` IDs; CI maps tests to them ([testing](../specs/testing.md)) |
| Eval suite count didn't add up (40 vs 43 listed) | Corrected |

New spikes: SPIKE-29 (web search usage fields and pricing), SPIKE-30 (provider search combined with function tools).

## Fifth pass: foundation audit ("will this force a rewrite?")

Lens: the plans read as an architecture, not as text. Which decisions would be expensive to undo once code exists?

| Severity | Fault line | Fix |
|---|---|---|
| Critical | Tools needed to ask the user, change mode, set taint, change cwd and call a model, but the module table forbids `tools → agent`. Builders would invent globals or back-imports. | `SessionEffect`s plus capabilities injected through `ToolContext`; state ownership section in 02; ADR-26 |
| Critical | Nothing required "no process-global state", yet v0.2 subagents and ACP need several sessions per process, and parallel tests need isolation. | Composition root `createRuntime(RuntimeDeps)`, state rules, a two-session test in M1 (interfaces §9) |
| Critical | `ProviderAdapter`/`Part` would be designed against Anthropic alone until M4. | M1 adapter-contract proof for Responses and Interactions using fixtures |
| High | WebSearch as a server tool in the main request made per-search permission prompts and taint-before-context impossible and leaked provider blocks into the transcript; it also conflicted with SPIKE-30. | Client-side tool with a secondary request (ADR-25); SPIKE-30 resolved |
| High | `--output stream-json` exposed internal events, so any log change would break users' scripts. | Public `glass.stream/1` schema (interfaces §10) |
| High | Interrupt keeps completed blocks, but the stream contract only delivered raw output on `done`. | `aborted` stream event with `completedRaw` |
| High | The checkpoint restore text contradicted itself (never `checkout-index`, then uses `checkout-index`), which would bring back the filter-execution hole. | Restore via `cat-file` + atomic writes only |
| Medium | Checkpoints lived in `agent`, but tools need the snapshot service. | Mechanics moved to `store`; `agent` decides when |
| Medium | TUI needed clipboard, `rg` and shell-mode execution with no allowed dependency; `!` ran outside the session (not logged, not killable, absent in ACP). | `tui → platform`; `Session.runUserShell` + `user.shell` event |
| Medium | Interactive permission/question/plan flows were untested until the M3 TUI (headless auto-denies). | Scripted Session-API tests in M1 |
| Medium | Tool results couldn't carry PDFs although Read returns them. | `DocumentPart` in `tool_result`; SPIKE-31 |
| Medium | The fixture tests relied on msw interception under Bun (unverified). | Fixture server + SDK base-URL override (verified for js-genai) |
| Low | Event-log writer rules were numbered out of order. | Fixed |
| — | Room for v0.2 (`mcp`, `hooks`, `lsp`) | Placeholder rows with allowed edges in 02 |

**Verdict:** the foundation is healthy. The fault lines were about who owns state and how capabilities reach tools, not about the stack or the overall design. With these fixes, every v0.2 feature in [extensibility](../specs/extensibility.md) attaches through an existing seam, with no change to `tools`, `policy` or `ai`.

