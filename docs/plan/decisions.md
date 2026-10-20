# Decisions (ADRs)

Each ADR states the decision, why, and when to revisit it. **ADRs explain decisions; the requirements themselves live in the specs they link to.** Each spec's "Before you build" box lists the ADRs that apply to it. ADRs are numbered in the order they were made; a replaced ADR keeps its number with a one-line pointer to its replacement. To change a decision, write a new ADR.

## One-way doors (decisions that are expensive to change)

- **Type 1 decisions** (hard to reverse; listed in the table) are derived from first principles: what is fundamentally true about Dovet's users, models, operating systems and threats. Each row states Dovet's own reason.
- **Type 2 decisions** (reversible: limits, defaults, prompt wording, tool details, UI behavior) are taken from the best available evidence (provider docs, other tools' shipped behavior; recorded in [research log](../background/feature-research.md)) and corrected by evals and use.

A change to any decision in this table needs a new ADR **and** a migration plan.

| # | Decision | Why it's hard to undo | Reason | ADR |
|---|---|---|---|---|
| 1 | TypeScript on Bun, compiled single binary | Everything is written in it | The code is written mostly by AI agents and read by the owner: TypeScript is the language agents write most reliably and the owner can read. Users install nothing else; a single binary needs no runtime. Every provider ships an official TypeScript SDK | 1 |
| 2 | Sessions = append-only JSONL + content-addressed blobs; any index is a disposable cache | Every session ever written must stay readable | A session log must survive a crash at any byte (append-only lines lose at most the last line), stay readable by people and tools (glass box), and be read whole on resume. Cross-session queries (`dovet cost`, search, the session picker) use an index that is **derived and rebuildable from the logs**, so deleting it loses nothing | 4 |
| 3 | Stored responses in Dovet's own format (parts plus the provider's replay data, unchanged) are the replay source; append-only epochs | Transcript builder, resume, receipts and rewind derive from it | Providers reject edited reasoning (Anthropic signatures, OpenAI encrypted reasoning, Gemini thought signatures), so replay must send back exactly what was received; prompt caches only hit on an unchanged prefix | 3, 4, 30 |
| 4 | Model layer = Vercel AI SDK (`ai` + `@ai-sdk/*` provider packages), one model step per call; Dovet's own agent loop on top | Every provider feature flows through it | Supporting every provider means tracking dozens of changing APIs; maintained packages do that daily, and they expose what the glass box needs (request bodies, raw chunks, provider metadata, cache usage). Dovet's value is the loop, safety and transparency, not wire formats | 30 |
| 5 | Module boundaries, state ownership, composition root | Retrofitting them touches every module | Subagents, ACP and several sessions in one process need state with exactly one owner; globals make each of those a rewrite | 22, 26 |
| 6 | Permission core = effects, enforced by the sandbox; ask at the edge of reversibility. The Claude-Code-compatible rule syntax is an input format | Every tool, the sandbox and users' trust depend on it | Command text can't be judged reliably (the shell is a full language); effects can be enforced by the OS; people approve blindly when asked too often. Workspace changes are reversible (checkpoints); network, outside writes and remote actions are not. So: free inside the boundary, ask when crossing it | 18, 28 |
| 7 | Instruction files: AGENTS.md + CLAUDE.md | Users' repos depend on them | Users already keep instructions in these files; a Dovet-only format would make every repo maintain one more file | 12 |
| 8 | Public output schemas (`--output json`, `dovet.stream/1`) | Users' scripts depend on them | Scripts can't adapt to silent changes; versioned separately from internal events so internals can change | 26 |
| 9 | Install layout, update channel, signing key embedded in binaries (no paid OS code-signing certificates until the project has income; Windows signing through SignPath Foundation's free open-source program) | Old binaries must be able to update | An old binary can only trust what it already contains; helpers (rg, sandbox) must ship beside the executable because the OS can't execute files embedded in a Bun binary | 20 |
| 10 | License: MIT | Every contribution is made under it; relicensing needs every contributor's consent | Open source is required by the glass-box promise and by provider programs for local apps (OpenAI "Sign in with ChatGPT"); MIT is the simplest permissive license and compatible with all dependencies | 29 |
| 11 | Public extension contracts (v0.2: hook input/output JSON, skills format, MCP config, ACP) | Users' scripts and extensions depend on them | Dovet reads existing standards (MCP, Agent Skills, Claude Code's hook JSON) instead of inventing formats, and versions every contract before release | v0.2 ADR before release |

**Swappable by design** (behind an interface, so a wrong choice costs one module, not the product): sandbox engine (`SandboxService`), checkpoint mechanism (`SnapshotService`), TUI library (consumes `AgentEvent`s only), search binary (`rg`), PDF/image libraries, model catalog source.

---

## ADR-1: TypeScript on Bun
**Decision:** TypeScript (v7, the native compiler) on the Bun runtime, compiled to a single binary with `bun build --compile`.
**Alternatives:** Rust, Go.
**Why:** AI agents write TypeScript most reliably; the owner can read and debug it; there are official SDKs for Anthropic, OpenAI, Google and MCP. Requiring users to install Node would be a barrier; a Bun single binary removes it. Bun is maintained by Anthropic (acquired Dec 2025), so long-term maintenance is likely.
**Minimum Bun: 1.4.3** (pinned in `package.json` `engines` and CI). **Type checking uses `bun check`** (built in since 1.4.3: a port of typescript-go, same errors as `tsc`, no `typescript` package needed, no emit, no language server) [VERIFIED, bun.com/blog/bun-v1.4.3]; `bun test --check` in CI. A short parity run against `tsc --noEmit` happens in M0; `tsc` is dropped unless real differences appear. Editors keep using TypeScript's language server.
**Build requirement:** compile with `.env` and `bunfig.toml` autoloading **disabled**; compiled Bun executables load them from the current directory by default [VERIFIED 2026-10-11, Bun docs] ([architecture Distribution](../specs/architecture.md)).
**Risks:** Native modules under Bun, and memory behavior in long sessions. Mitigated by a minimal-native-modules rule and a 4 h soak test.
**Revisit if:** The soak test fails repeatedly, or sandboxing requires native code we can't ship.

## ADR-2: replaced by ADR-30 (model layer on the AI SDK).

## ADR-3: Append-only transcript with epochs
**Decision:** Within an epoch, each request's `system`, `tools` and `messages` are a byte-identical prefix of the next. Mid-session changes are appended (system messages, reminder blocks), never edited in. Compaction, a model switch or a repair starts a new epoch ([context §5–6](../specs/context.md)).
**Why:** On current Anthropic models (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5), thinking blocks are bound to the exact prefix that produced them. Edits cause 400 errors (accounts created from 2026-08-31) or drop the reasoning, and they always break the cache [VERIFIED 2026-10-10, Anthropic API docs: preserved thinking]. Other providers' prompt caches also only hit on an unchanged prefix.
**Alternatives rejected:** keep-tail compaction, deleting old tool results client-side, editing the system prompt mid-session.

## ADR-4: Append-only JSONL event log + content-addressed blob store (no database)
**Decision:** Each session is an append-only JSONL file of typed events, plus a disposable `.meta.json` sidecar for listing. **No database.** File contents go in a content-addressed blob store. Each model response is stored once, in Dovet's own part format with the provider's replay data (ADR-30); views are derived. Each epoch stores the exact system-prompt and tool-definition bytes so resume never re-renders them ([event-log](../specs/event-log.md)).
**Why:** Receipts, `/why`, resume, replay and rewind are all views of one log. JSONL is greppable and debuggable. Two stores that must stay in sync are a bug source. Writes are buffered to avoid SSD wear.
**Alternatives rejected:** SQLite as the primary store or as an index (harder to inspect, migration burden, a second source of truth).
**Revisit if:** listing sessions exceeds 200 ms with real data (then add a rebuildable index, not a second source of truth).

## ADR-5: Vendored pi-tui for the terminal UI
**Decision:** Vendor the **TypeScript core** of `@earendil-works/pi-tui` (MIT; copied code, so its license notice is kept in the vendored directory) into `src/tui/vendor/pi-tui`, **without** its optional native addons (clipboard/modifier `.node` modules); clipboard uses OSC 52 and platform CLIs ([tui](../specs/tui.md)). Inline mode (`TuiMainScreen`, keeps native scrollback) is the default; `TuiAltScreen` (fullscreen) is an option. Dovet modifies its copy where [tui](../specs/tui.md) requires (live-region-only resize, input-first render slices) [SPIKE-4].
**Why:** Dovet needs differential rendering with synchronized output, both inline and fullscreen modes, an editor, markdown, overlays and a virtual terminal for tests, with few dependencies; pi-tui has all of these and 2 dependencies. React-based terminal renderers redraw whole trees and flicker on long streams. It's vendored because small critical libraries from single maintainers can stall.
**Revisit if:** SPIKE-4 fails on Windows Terminal.

## ADR-6: Anthropic sandbox-runtime for OS sandboxing
**Decision:** `@anthropic-ai/sandbox-runtime` (Apache-2.0) wraps shell commands (and MCP stdio servers in v0.2). Pin an exact version. Helper files ship in `libexec/srt/` and are passed by explicit path (ADR-20).
**Why:** It covers bubblewrap + seccomp on Linux, Seatbelt on macOS and a Windows backend (dedicated local user + WFP firewall + NTFS ACLs), and includes HTTP and SOCKS5 proxies with domain allow/deny lists and an ask-callback for unknown domains [VERIFIED 2026-10-10, README].
**Windows (owner decision, 2026-10-12):** three levels, tried in order:
1. **Microsoft Execution Containers** through Microsoft's official Node SDK `@microsoft/mxc-sdk` (MIT, 1.0.0 released 2026-10-06; process isolation built into Windows 11 24H2/25H2 from build 26100.9278 / 26200.9278; no admin setup) [VERIFIED 2026-10-12, github.com/microsoft/mxc and developers.openai.com/codex/windows] [SPIKE-42];
2. sandbox-runtime's Windows backend (dedicated low-privilege user + WFP firewall + NTFS ACLs), offered once with consent because it needs an administrator-approved setup (`dovet sandbox install`);
3. no sandbox: shell commands are judged by their text and more of them ask ([permissions §0b](../specs/permissions.md)).
WSL2 uses the Linux sandbox. This is the same order as a shipping Windows-native coding agent uses. MXC also has Linux (bubblewrap) and macOS (Seatbelt) backends, so it is a candidate to replace sandbox-runtime everywhere later; `SandboxService` keeps that swap to one module.
**Risks:** Running inside a Bun-compiled host is unverified [SPIKE-16]; the library is a beta; Linux needs `bwrap`, `socat` and `ripgrep`; Ubuntu 24.04+ AppArmor blocks user namespaces unless configured. Handled by `dovet doctor` and explicit degraded modes ([permissions §7](../specs/permissions.md)).

## ADR-7: Exact-match edit tool, one for every model
**Decision:** every model uses `Edit` with exact unique-string replacement plus defined normalization levels only ([tools §3](../specs/tools.md); no fuzzy similarity). No provider-native edit tools (OpenAI `apply_patch`, Anthropic `text_editor`).
**Why:** Fuzzy matching applies edits to the wrong place; exact matching fails loudly and the model retries. One edit tool for all models keeps behavior, permissions, checkpoints and tests identical across providers (ADR-31).

## ADR-8: Ripgrep for Grep and Glob
**Decision:** Ship the `rg` binary in `libexec/` (the OS can't execute files inside the compiled binary) and use it for Grep (`rg --json`) and Glob (`rg --files --glob`).
**Why:** Fastest available; respects .gitignore; identical matching on every OS; sandbox-runtime already requires it on Linux and macOS.
**Risk:** Install layout [SPIKE-2].

## ADR-9: tree-sitter for shell command parsing
**Decision:** `web-tree-sitter` with the bash and powershell grammars (WASM) to parse commands for permission checks ([permissions §4.0](../specs/permissions.md)).
**Why:** Regex parsing misses `$(...)`, pipes, subshells and quoting.
**Risk:** Loading WASM grammars from a compiled binary [SPIKE-15].

## ADR-10: replaced by ADR-19 (checkpoints).

## ADR-11: No memory tool and no vector database
**Decision:** v0.1 has no memory tool and no vector database. Memory is plain files (AGENTS.md and notes) edited with normal tools. (The task-list tool is ADR-27.)
**Why:** Plain files are visible, versionable and editable by the user; a hidden memory store contradicts the glass box.
**Revisit if:** Evals show a measurable gain.

## ADR-12: Read the formats users already have
**Decision:** Read AGENTS.md and CLAUDE.md (including `@path` imports) ([context §3](../specs/context.md)), Claude Code permission rule syntax and settings ([permissions](../specs/permissions.md), [cli-config "Coming from Claude Code"](../specs/cli-config.md)), and in v0.2 `.claude/skills/*/SKILL.md`, `.mcp.json` and Claude Code's hook event names ([extensibility](../specs/extensibility.md)).
**Why:** Switching to Dovet should cost nothing (principle 4). These are the most widely used formats for coding-agent instructions, permissions, skills and MCP configuration.

## ADR-13: Only officially permitted login methods, per provider
**Decision:** Each provider record lists the login methods that provider officially allows for third-party tools: API key, account login (OAuth), coding-plan key, or none for local servers ([providers Provider registry](../specs/providers.md), [cli-config "Connecting providers"](../specs/cli-config.md)). Dovet never reuses browser sessions or uses unofficial OAuth clients. A method is added or removed by editing the registry when a provider's terms change.
**Current examples:** OpenAI "Sign in with ChatGPT" is offered (officially open to local open-source apps since 2026-09-29; flow in [cli-config](../specs/cli-config.md)); Anthropic account (Claude subscription) login is **not** offered, because Anthropic's terms don't permit it for third-party tools; OpenRouter's OAuth (which issues a user-owned API key) is offered; GitHub Copilot and xAI subscription logins are not, because both admit only allowlisted partner clients. **Dovet never uses another product's OAuth client ID**: a login method needs Dovet's own registered client or an open registration (such as Sign in with ChatGPT's dynamic registration).
**Why:** Unpermitted logins get users' accounts suspended and the integration removed.

## ADR-14: No forced tool choice; explicit effort
**Decision:** Never send a forced tool choice (`tool_choice` `any`/`tool`; rejected by current Claude models). Always send `effort` explicitly, using the model's recommended level from the catalog unless the user set one ([providers §2–3](../specs/providers.md)), so the effective setting is visible and never changes silently. Use adaptive thinking on Anthropic models that support it.

## ADR-15: Runtime dependencies
Every runtime dependency must be listed here before it is added. Exact versions are pinned in the lockfile.

| Dependency | Purpose | Notes |
|---|---|---|
| `ai` | AI SDK core: `streamText` for one model step per request (ADR-30); also `wrapLanguageModel` middlewares and `parsePartialJson` ([providers](../specs/providers.md)) | Apache-2.0; exact pin; upgrades gated by replay tests |
| `@ai-sdk/provider` | Provider interface, for any custom provider Dovet must write | Apache-2.0 |
| `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/open-responses`, `@ai-sdk/openai-compatible`, `@ai-sdk/gateway`, `@ai-sdk/deepseek`, `@ai-sdk/alibaba`, `@ai-sdk/moonshotai`, `@ai-sdk/zai`, `@ai-sdk/minimax`, `@ai-sdk/xai`, `@ai-sdk/groq`, `@ai-sdk/mistral` (+ other official `@ai-sdk/*` provider packages as the registry needs) | Provider packages | Apache-2.0; bundled in the binary; exact pins |
| `zod` | Schemas for every boundary | v4 |
| `@ai-sdk/mcp` (v0.2) | MCP client | Apache-2.0; covers MCP 2026-07-28 and legacy servers, stdio/HTTP/SSE, OAuth ([extensibility](../specs/extensibility.md)) |
| `web-tree-sitter` + `tree-sitter-bash` + `tree-sitter-powershell` | Shell parsing | WASM, no native code |
| `@anthropic-ai/sandbox-runtime` | OS sandbox | Exact pin; beta |
| `marked`, `get-east-asian-width` | pi-tui dependencies | Vendored TUI |
| `shiki` | Syntax highlighting in diffs and code blocks | Lazy-load grammars [SPIKE-6] |
| `diff` | Diff computation for receipts and review | |
| `fuzzysort` | `@file` mention and palette fuzzy search | |
| `ignore` | .gitignore semantics where rg isn't used | |
| `@mozilla/readability`, `linkedom`, `turndown` | WebFetch HTML → markdown | |
| `jsonc-parser` | Config files with comments | |
| `yaml` / `gray-matter` | SKILL.md frontmatter (v0.2) | |
| `ulid` | Sortable event IDs | |
| `Bun.secrets` (built into Bun) | OS keychain for API keys (macOS Keychain, Windows Credential Manager, Linux libsecret) | Replaces `@napi-rs/keyring`: no native module. Marked experimental by Bun → `just-secrets` fallback [SPIKE-5] |
| `just-secrets` (only if SPIKE-5 needs it) | Keychain fallback: same three OS stores through the OS's own tools (`security`, `secret-tool`, PowerShell) | MIT, zero dependencies, Vercel Labs |
| `guarded-fetch` | WebFetch: SSRF protection (resolve-and-pin, every redirect re-checked) ([tools §9](../specs/tools.md)) | Apache-2.0; runs on Bun only if SPIKE-45 passes |
| ripgrep binary | Grep/Glob | Bundled per platform [SPIKE-2] |
| `@microsoft/mxc-sdk` | Windows sandbox (MXC process containers) | MIT; Windows only in v0.1 [SPIKE-42] |
| Pure-JS PDF library (chosen in SPIKE-6) | Read: page ranges, text extraction | No native code; works on Windows without poppler |
| `Bun.Image` (built into Bun, chosen in SPIKE-6) | Read and pasted images: decode, resize, re-encode | Not a package: statically linked libjpeg-turbo, libspng and libwebp inside Bun; GIF decodes its first frame |

**Dev-only (never shipped):** `ai/test` mocks, `@vercel/agent-eval` (evals, [testing](../specs/testing.md)), `dependency-cruiser` (import-boundary check, [architecture](../specs/architecture.md)), `@ai-sdk/devtools`, `@ai-sdk/codemod` (AI SDK major upgrades), `fast-check`.

**Licenses:** Dovet is MIT; bundled dependencies may be MIT, Apache-2.0, BSD or ISC. The release build generates `THIRD_PARTY_NOTICES` from the bundled packages (license text plus any Apache `NOTICE` file), and ships it in the install directory ([architecture](../specs/architecture.md)).

Not used: Ink/React, LangChain, Effect, the AI SDK's agent classes and UI packages, drizzle, simple-git (git is invoked directly), node-pty in v0.1 (no interactive PTY tool in v0.1), keytar (unmaintained).

## ADR-16: Open Responses as the main compatible protocol
**Decision:** Open Responses servers (OpenRouter, Ollama, LM Studio, vLLM, Hugging Face) are reached through `@ai-sdk/open-responses`; Chat Completions (`@ai-sdk/openai-compatible`) is the fallback only ([providers](../specs/providers.md)).
**Why:** Open Responses (launched 2026-01-15) carries reasoning items, `phase` and typed tool calls; Chat Completions can't carry reasoning across turns. One adapter covers OpenAI plus most aggregators and local runtimes.
**Risk:** Uneven conformance across servers [SPIKE-21].

## ADR-17: Gemini via the Interactions API
**Decision:** Native Gemini support uses the Interactions API in stateless mode (`store: false`, full-history replay), via `@ai-sdk/google`'s `google.interactions(...)`. `generateContent` (the same package's default model) is a fallback only if needed [SPIKE-19].
**Why:** Google recommends Interactions for new projects and new agent capabilities land there first; stateless replay with thought signatures and implicit caching works.

## ADR-18: Claude-Code-compatible permission rules and modes
**Decision:** Permission modes, rule grammar, safety checks (protected paths, critical paths, symlinks, redirections, read-only set), prompt options, sandbox auto-allow, unsandboxed retry and workspace trust use the same names and syntax as Claude Code's documented behavior, so existing settings import unchanged ([permissions](../specs/permissions.md)). How decisions are made underneath is ADR-28.
**Why:** It is the most widely used rule format for coding agents; users' existing rules and habits carry over.

## ADR-19: Git tree snapshots in a private object store
**Decision:** In git workspaces, checkpoints are git trees built with a private index (`GIT_INDEX_FILE`) and a private, self-contained object directory (no alternate: git would refresh the timestamps of the user's objects, and checkpoints would depend on objects the user can prune). Non-git workspaces fall back to file-level blobs ([checkpoints](../specs/checkpoints.md)).
**Why:** Sandbox auto-allow lets shell commands edit files without prompts, so checkpoints must cover shell changes. This is incremental (stat cache) and never writes to the user's `.git`; the price is one compressed copy of the workspace in Dovet's store (QUESTIONS Q3).
**Filter safety:** snapshots use plumbing that runs no clean/process/smudge filters (`ls-files`, `fast-import` with exact-length blobs in Dovet's own bare repository, `update-index --index-info`, `write-tree`, `diff-tree`, `cat-file`); `git add`/`checkout` are forbidden in this module (a test scans the module's source for them).
**Risk:** Performance on huge repos and Windows correctness [SPIKE-22].

## ADR-20: Install-directory distribution
**Decision:** Ship `dovet(.exe)` plus `libexec/` (ripgrep, sandbox-runtime helpers) in versioned directories with an atomic current-version pointer. Only JS, WASM grammars and data are embedded in the compiled executable ([architecture Distribution](../specs/architecture.md)).
**Why:** Executables embedded in a Bun binary can't be run by the OS; sandbox-runtime expects its helpers on disk and outside sandbox write grants.

## ADR-21: Early execution of local read tools
**Decision:** Start Read, Grep and Glob calls that the policy allows without a prompt as soon as their tool-call block completes during streaming; discard the results if the response ends in refusal, truncation or interrupt ([agent-loop](../specs/agent-loop.md)).
**Why:** Cuts turn latency; reads have no side effects.

## ADR-22: Single package with enforced import boundaries
**Decision:** One Bun package with module folders and a CI import-boundary check, instead of a multi-package workspace ([architecture](../specs/architecture.md)).
**Why:** Less build and config overhead for a solo developer; simpler for AI agents to navigate; boundaries are still enforced. Extract a module into its own package only when it must be published.

## ADR-23: Own core, not a fork of an existing harness
**Decision:** Build Dovet's own core; vendor only pi-tui's core (ADR-5).
**Why:** Dovet's core (append-only epochs, event-sourced log, receipts, budgets, sandbox-first permissions) differs fundamentally from existing minimal harnesses, several of which deliberately ship without permissions or sandboxing. A fork would mean fighting upstream design and churn.

## ADR-24: The Vercel / AI SDK ecosystem: what Dovet uses
Rule (owner, 2026-10-12): when a maintained package meets a requirement, use it; write Dovet's own code only where a requirement can't be met, and say why.

Audit of every `@ai-sdk/*` package, every `vercel` and `vercel-labs` repository active in 2026, and the `ai` core exports [VERIFIED 2026-10-12, npm registry and package type declarations].

**Used**

| Package | Where | Why |
|---|---|---|
| `ai` core + `@ai-sdk/*` providers | Model layer (ADR-30, [providers](../specs/providers.md)) | Provider formats for every provider, maintained daily |
| `@ai-sdk/gateway` | Provider preset ([providers](../specs/providers.md)) | Routing pinned and recorded |
| `ai` middlewares: `extractReasoningMiddleware`, `simulateStreamingMiddleware` | Endpoint quirks ([providers](../specs/providers.md)) | Inline `<think>` reasoning and non-streaming servers without Dovet code |
| `ai` `parsePartialJson` | Streaming tool-argument display | No separate partial-JSON library needed |
| `ai/test` (`MockLanguageModelV4`, `simulateReadableStream`) | Loop, Session-API and soak tests ([testing](../specs/testing.md)) | Scripted model without HTTP |
| `@ai-sdk/mcp` | MCP client, v0.2 ([extensibility](../specs/extensibility.md)) | MCP 2026-07-28 + legacy, stdio/HTTP/SSE, OAuth; returns AI SDK tool definitions |
| `@ai-sdk/code-mode` | Code mode, v0.3 candidate ([extensibility](../specs/extensibility.md)) | QuickJS sandbox (`run`) calling Dovet's tools |
| `@vercel/agent-eval` | Eval suite ([testing](../specs/testing.md)) | Runs coding agents on tasks in Docker sandboxes, custom agents supported, Claude Code / Codex / Gemini CLI baselines built in |
| `skills` CLI (`npx skills`) | Skill install locations ([extensibility](../specs/extensibility.md)) | Dovet reads the folders it installs to (`.agents/skills/`), so users install skills with it |
| `@ai-sdk/harness-acp` | Nothing to build | Once Dovet speaks ACP (v0.2), AI SDK apps drive it through this adapter; no Dovet-specific harness package |
| `just-secrets` | Keychain fallback [SPIKE-5] ([cli-config](../specs/cli-config.md)) | Zero-dependency OS keychain access |
| `guarded-fetch` | WebFetch SSRF protection [SPIKE-45] ([tools §9](../specs/tools.md)) | DNS-rebinding-safe fetch with checked redirects |
| `AI_AGENT` convention (`detect-agent`) | Shell env ([tools §5](../specs/tools.md)) | Tools that check `AI_AGENT` see `dovet`; no dependency |
| `@ai-sdk/devtools`, `@ai-sdk/codemod` | Dev-only | Inspecting requests while building Dovet; AI SDK major upgrades |

**Not used**

| Package | Why |
|---|---|
| `ToolLoopAgent` / agent classes, `@ai-sdk/workflow`, `workflow`, `eve` | Dovet's loop (epochs, budgets, guards, interrupts that keep completed blocks, queued input, the permission flow) is the product's core ([agent-loop](../specs/agent-loop.md)) |
| `toolApproval` / `needsApproval`, `@ai-sdk/policy-opa` | Tools run outside the SDK; permissions are decided on effects by Dovet's policy engine with Claude Code-compatible rules ([permissions](../specs/permissions.md)). A second rule language (Rego) would split the policy |
| `experimental_repairToolCall` | Malformed tool input is reported to the model, never silently repaired ([agent-loop](../specs/agent-loop.md)) |
| `pruneMessages` | Editing history inside an epoch breaks the prefix rule; compaction starts a new epoch ([context](../specs/context.md)) |
| SDK retries | `maxRetries: 0`; Dovet logs and shows every attempt and fails over ([providers §7](../specs/providers.md)) |
| `@ai-sdk/tui` | A minimal fullscreen agent UI (y/n approvals, Esc exits); Dovet's TUI needs inline scrollback, queueing, rewind, plan and question dialogs, paste and IME handling ([tui](../specs/tui.md)) |
| `@ai-sdk/harness` + `harness-*` | For driving other agents from an AI SDK app; Dovet is the agent |
| `@ai-sdk/otel`, `@vercel/otel` | No telemetry |
| `just-bash`, `@ai-sdk/sandbox-*`, Vercel Sandbox | A simulated or cloud shell; Dovet runs the user's real shell inside an OS sandbox ([permissions](../specs/permissions.md)) |
| `agent-browser`, `opensrc`, `emulate` | Standalone CLIs; users can run them through the shell or as skills, nothing to integrate |
| `@vercel/error`, `nostics` | Requires Node 24 / built for web frameworks; Dovet's error messages are specified per tool ([tools](../specs/tools.md)) |
| Chat SDK, React/Vue/Svelte UI, `ai-elements`, `streamdown`, `json-render` | Chat bots and web UI; Dovet is a terminal tool |
| `konsistent` | Checks file structure, not import edges; the boundary check uses `dependency-cruiser` |

## ADR-25: WebSearch is a client-side tool backed by a secondary request
**Problem:** declaring a provider's server search tool in the main request makes the provider run searches itself: Dovet can't ask permission per search or taint the session before the results enter the context, provider-specific blocks enter the main transcript (breaking provider switching), and `pause_turn` enters the main loop.
**Decision:** a client tool `WebSearch` whose `run()` makes a separate request containing only the search mechanism of the current provider (or a configured search service) ([tools §10](../specs/tools.md)). Permission, taint, receipts, budgets and replay work like every other tool; the main transcript stays provider-neutral.
**Cost:** one extra request per search (no history, effort `low`), shown in the receipt.

## ADR-26: State ownership, injected capabilities and a composition root
**Problem:** tools need to ask the user, change the mode, set taint, change the cwd, call a model and (v0.2) spawn subagents, but the module rules forbid them from importing `agent`. Globals or back-imports would make subagents and ACP (several sessions per process) a rewrite.
**Decision:** `agent` owns session state; tools return `SessionEffect`s; user, model and subagent access is injected through `ToolContext`; everything environment-dependent comes from `RuntimeDeps` at one composition root; no module-level mutable state, no `process.chdir`/`process.env` writes ([interfaces §4, §9](../specs/interfaces.md), [architecture State ownership](../specs/architecture.md)). Snapshot mechanics live in `store` so tools can use them without importing `agent`.
**Why not a DI framework:** one `createRuntime` function and plain objects cover it.

## ADR-27: A task-list tool
**Decision:** `TodoWrite`, the same for every model, with no side effects ([tools §12](../specs/tools.md)).
**Why:** Current models are trained to keep a task list for multi-step work; Anthropic's Opus 5.5 guidance recommends a checklist the model updates so unattended runs don't stop with work open; users follow long tasks through it ([user-journeys](../product/user-journeys.md)).
**Revisit if:** SPIKE-13's eval (with and without the tool) shows no benefit; then remove it.

## ADR-28: Effect-based permission core: ask at the edge of reversibility
**Fundamentals:**
1. The model can be wrong or manipulated (prompt injection), so its intent can't be trusted.
2. Shell command text can't be judged reliably: the shell is a complete programming language, and text checkers keep needing fixes for new bypasses. Effects (which files change, which hosts are contacted) can be enforced by the operating system.
3. People asked too often approve without reading, so every prompt spends the user's attention and must be worth it.
4. Workspace changes are reversible: checkpoints (ADR-19) cover tool and shell edits. Network traffic, writes outside the workspace and remote actions (push, publish, deploy, messages) are not.

**Decision:** the policy engine decides on an action's **effects**, not its text.
- **Inside the boundary** (workspace writes covered by checkpoints, reads outside credential paths, network to allowed hosts only, enforced by a healthy sandbox), actions run without prompts.
- **Crossing it** asks: outside writes, a new host, unsandboxed execution, a recognized remote action, protected or critical paths.
- **Every prompt Dovet shows must name the boundary it protects** ([permissions §0b](../specs/permissions.md)). The one exception is the user's chosen review preference (Manual mode reviews file edits), which is labelled as review, not safety.
- **The Claude-Code-compatible rule syntax** (ADR-18) stays as the user-facing **input format**: rules compile into matchers on tools, inputs and effects. Deny/ask rules on command text are guardrails against mistakes, not the boundary.
- **Where no sandbox runs** (native Windows without the backend, degraded states), effects are unknown, so non-read-only commands ask. The status bar says that commands are judged by text, which is weaker.

**Also part of the decision:**
- Rules carry **examples that are checked at load** (`permissions.examples`).
- (v0.2) An automatic reviewer only sees actions that **already** need approval, never in-boundary ones. This keeps reviewer cost and injection surface small.

**Alternatives:**
- **A classifier model reviews most actions** (sandbox optional): depends on a model call per action; Dovet is provider-neutral and cost-conscious.
- **Per-command approval without a sandbox:** approval fatigue, and it still can't judge the text.

**Residual risks, documented:**
- **Allowed hosts are channels:** a pre-allowed package registry can carry data out. Mitigated by credential denial, env scrub, and taint suspending auto-allow; the TLS-terminating proxy is v0.2.
- **Native Windows** has no sandbox by default [SPIKE-42].

**Revisit if:** the sandbox can't be made reliable on a first-class OS, or evals show the reviewer placement misses real attacks.

## ADR-29: License: MIT
**Decision:** Dovet is released under the MIT license.
**Why:** open source is required by OpenAI's "Sign in with ChatGPT" program for local apps and by the glass-box promise; MIT is the simplest permissive license. It is compatible with every listed dependency (MIT, Apache-2.0, BSD, ISC); bundled dependencies' license texts and `NOTICE` files ship in `THIRD_PARTY_NOTICES` (ADR-15).
**Attribution rule:** other projects are named only where Dovet copies their code (then their license notice is kept, e.g. pi-tui). Ideas and approaches are used freely and not credited.

## ADR-30: Model layer on the AI SDK (2026-10-12, owner request; replaces ADR-2)
**Decision:** every model request goes through Vercel's AI SDK: `streamText` from `ai`, one model step per call, tools without `execute`, `maxRetries: 0`, with the provider package each registry record names (`@ai-sdk/*`, or `@ai-sdk/openai-compatible` / `@ai-sdk/open-responses`). Dovet keeps its own agent loop, transcript and epochs, permissions, tools, retries, cost and registry ([providers](../specs/providers.md), [agent-loop](../specs/agent-loop.md)).
**Why:** Dovet must work with every provider. Each provider's API changes often; the AI SDK packages are maintained against them and released several times a week (all current Anthropic, OpenAI, Google and Chinese-provider features were already supported on 2026-10-12, including thinking display modes, per-message effort, turn-scoped system messages, 1-hour cache control, OpenAI `apply_patch`/`shell` and encrypted reasoning, Gemini Interactions, and DeepSeek/Qwen/Kimi reasoning replay). They expose what the glass box needs: request bodies, raw chunks, provider metadata and normalized cache usage. Writing and maintaining wire formats is not Dovet's value.
**The log never depends on the SDK:** `model.response` stores Dovet's own parts with the provider's replay data (wire-format field names), and the adapter converts to and from the SDK's messages losslessly ([providers §1](../specs/providers.md)). The SDK can therefore be replaced for any protocol later (by Dovet's own code, possibly started from the SDK's Apache-2.0 provider code with its notice) without migrating a single session. Replacement happens per protocol and only on evidence: a failed fidelity gate, a requirement the SDK can't meet without workarounds, or repeated upstream bugs.
**Keeping fidelity:** exact version pins; every SDK upgrade passes the golden replay tests, the prefix property test and the Anthropic `prefix_mismatch_behavior: "error"` CI run; a custom `fetch` records exact request bytes [SPIKE-44].
**If a package lags or gets something wrong:** pass the field through `providerOptions` or headers; if that's not enough, write a small custom provider against `@ai-sdk/provider` for that endpoint. Never a second code path in the loop.
**Revisit if:** an SDK upgrade repeatedly breaks replay fidelity, or the project stops being maintained. Known counter-evidence (2026-10): OpenCode's v2 core moved its main protocols (OpenAI, Anthropic, Bedrock, Azure, OpenAI-compatible) from AI SDK packages to its own native implementations and keeps the AI SDK only as a bridge for other packages; its v1 stays on AI SDK v7. Several of its bugs came from loading `@ai-sdk/*` packages of a different major version at runtime, which Dovet avoids by bundling exact pins. The M1 fidelity gate [SPIKE-44] decides; its fallback is native code for the failing protocol only.

## ADR-31: One prompt and one tool set for every model (2026-10-12, owner decision)
**Decision:** every model, from every provider, gets the same system prompt, the same tools and the same tool descriptions ([prompts](../prompts/README.md), [providers §9](../specs/providers.md)). No per-family prompts, no per-model overlays, no provider-native tools in the main conversation. Per-model differences are data only (effort, thinking display, sampling, strict-tool support, caching, limits).
**Why:** Dovet is provider-neutral: its behavior must not depend on which company made the model. One set is one thing to write, test, review and keep honest (glass box), and switching models mid-session never changes the tools the model sees. Current models handle the common tool shapes (Read/Edit/Bash) well, and input normalization absorbs the variations they send ([tools §0](../specs/tools.md)).
**Cost accepted:** some models were trained on their vendor's own tool shapes (OpenAI's `apply_patch`, Anthropic's built-in editor) and may do slightly better with them.
**Revisit if:** the eval suite shows a measurable gain for a model family with a variant that the shared set can't reach [SPIKE-13]; such a variant then needs its own ADR.
