# Dovet — Plan & Specifications

> **Status: in development.** M0 and M1 are done (headless `dovet -p` works on NVIDIA); M2 (safety and recoverability) is in progress. The task lists in [plan/tasks/](plan/tasks/) hold each task's status ([roadmap](plan/roadmap.md)).
> **Name:** Dovet (command `dovet`). It was planned under the codename "Glass"; the "glass box" (nothing hidden) remains the product's core idea.
> **License:** MIT (ADR-29).

Dovet is a terminal coding agent (a "harness"). It runs on Windows, macOS and Linux, works with any model provider (NVIDIA first; then OpenAI, Google, Chinese platforms such as DeepSeek, Qwen, Kimi, GLM and MiniMax, gateways, and local models), and is written in TypeScript on Bun.

Its promise is **trust through transparency**: the agent cannot hide what it did, what it cost, or what it was told ([vision](product/vision.md)).

---

## How to use these docs

These specs are written to be **built from by an AI coding agent** and reviewed by a human.

1. **Specs are the source of truth.** If code and spec disagree, the code is wrong, or the spec is changed first (an ADR in [decisions](plan/decisions.md) for decisions). If a spec is unclear or two specs disagree, the agent decides the best answer, records it in [QUESTIONS](plan/tasks/QUESTIONS.md) and writes it into the spec in the same PR; the owner can override it later.
2. **Every feature has acceptance criteria** (`AC-<SPEC>-<n>`, e.g. `AC-TOOLS-04`). A feature is done when each criterion has a passing automated test tagged with its ID (or a documented manual check where automation is impossible).
3. **Nothing is guessed.** External facts are marked `[VERIFIED date]`. Anything unverified is a **spike** in [open-questions](plan/open-questions.md): resolve it before building the feature that depends on it.
4. **Build in milestone order** ([roadmap](plan/roadmap.md)). v0.2 items are described so v0.1 leaves room for them; don't build them early.
5. **One home per requirement.** Every requirement lives in the spec of the feature it belongs to. The cross-cutting docs (decisions, roadmap, open questions, user journeys) only explain, order or point; they never add requirements. Each spec starts with a generated **"Before you build"** box listing its milestone, decisions, open questions with fallbacks, and user journeys (`bun run docs:boxes`).
6. **What to read for a task:** run `bun run next`; it prints the task and the exact spec sections it needs. For background on the whole design: [principles](product/principles.md), [architecture](specs/architecture.md), [interfaces](specs/interfaces.md).

## Status markers

| Marker | Meaning |
|---|---|
| **[v0.1]** / **[v0.2]** / **[v0.3]** | The release this belongs to. Unmarked text in a `[v0.1]` doc is v0.1 |
| **[VERIFIED yyyy-mm-dd]** | An external fact checked against a primary or reliable source on that date |
| **[SPIKE-n]** | Depends on open question *n* in [open-questions](plan/open-questions.md); resolve it before implementing |
| **[DECISION-n]** / **ADR-n** | Governed by that ADR in [decisions](plan/decisions.md) |
| **MUST / MUST NOT / SHOULD / MAY** | RFC 2119 meanings |

## Feature status

"Milestone" is where each v0.1 feature is built ([roadmap](plan/roadmap.md)); the task lists say what is done.

| Area | v0.1 (milestone) | Later | Not supported |
|---|---|---|---|
| Providers (through the AI SDK's provider packages, ADR-30) | NVIDIA through `@ai-sdk/openai-compatible` (M1, QUESTIONS Q23); OpenAI Responses, Open Responses servers, every models.dev provider (226) through the provider registry, incl. Chinese platforms, coding plans, Gemini and local servers (M4) | Anthropic and Bedrock/Vertex/Foundry only if the owner adds them (Q23) | Unofficial or unpermitted logins (e.g. Claude subscription, Google AI Pro/Ultra) |
| Login | API keys, local servers (M1/M3); `/login` + first-run wizard (M3); Sign in with ChatGPT (M4) | Copilot/xAI/OpenRouter account logins once terms are confirmed | Reusing other tools' stored credentials |
| Tools | Read, Write, Edit, Bash/PowerShell, Grep, Glob, AskUserQuestion, TodoWrite, plan mode (M1); WebFetch, WebSearch (M2); the same tools for every model | NotebookEdit, LSP, background tasks, Monitor (v0.2) | Interactive TTY programs; long-running servers started by the agent (v0.1) |
| Safety | Permission rules and modes (M1); sandbox, taint, trust, secret redaction (M2) | Auto mode with a model reviewer (v0.2) | Autonomous push/publish without the user's say-so |
| Context | Epochs, instruction files, compaction (M1/M2) | Auto memory (v0.2); provider-native compaction (v0.3 candidate) | Memory tools, vector databases |
| Recovery | Event log, resume, crash recovery (M1); checkpoints and rewind (M2) | — | — |
| UI | Headless `-p` (M1); TUI (M3) | Vim mode, custom keybindings, status-line command, output styles (v0.2) | IDE extensions, desktop or web apps (ACP gives editor support in v0.2) |
| Extensions | — | MCP, skills, custom commands, hooks, subagents, ACP (v0.2) | — |
| Distribution | Install scripts, signed releases, self-update (M0/M3) | Package managers (v0.2); free Windows signing via SignPath Foundation once accepted | Paid code-signing certificates (until the project has income); Dovet accounts, login servers, telemetry |

## Key terms

| Term | Meaning | Spec |
|---|---|---|
| Event log | The append-only JSONL file per session; every other view is derived from it | [event-log](specs/event-log.md) |
| Epoch | A stretch of a session whose request prefix only grows; compaction, model switches and repairs start a new one | [context §1](specs/context.md) |
| Shared tool set | The one prompt and tool set every model gets; per-model differences are data | [providers §9](specs/providers.md) |
| Provider record | Registry data describing a provider's endpoints, login methods, billing and quirks | [providers "Provider registry"](specs/providers.md) |
| Working directories / project root | Permission scope vs storage and trust key | [cli-config "Two directory concepts"](specs/cli-config.md) |
| Boundary | What runs freely vs what asks, decided on effects | [permissions §0b](specs/permissions.md) |
| Taint | Session flag set when untrusted content arrives; tightens permissions | [permissions §10](specs/permissions.md) |
| Checkpoint | Snapshot before a turn's first change; rewind restores it | [checkpoints](specs/checkpoints.md) |
| Receipt | Code-generated turn summary with claims checked against the log | [receipts-budgets](specs/receipts-budgets.md) |
| Mid-epoch instruction | A fixed harness text appended (never edited in) during an epoch | [context §4](specs/context.md) |

## Folders

| Folder | What's in it | Who reads it |
|---|---|---|
| [workflow/](workflow/) | [Build loop](workflow/build-loop.md) (what "continue" means, step by step), [dev workflow](workflow/dev-workflow.md) (rules for every change), [playbook](workflow/playbook.md) (the owner's guide) | Agents every session; the owner |
| [plan/](plan/) | [Roadmap](plan/roadmap.md) (milestones), [decisions](plan/decisions.md) (ADRs), [open questions](plan/open-questions.md) (spikes and product decisions), [tasks/](plan/tasks/) (task lists, progress log, decided questions) | Agents when choosing and planning work |
| [specs/](specs/) | What to build, one file per area (below) | Agents for the sections their task names |
| [product/](product/) | [Vision](product/vision.md), [principles](product/principles.md), [user journeys](product/user-journeys.md) | Anyone deciding what the product should do |
| [prompts/](prompts/README.md) | The system prompt, mode texts, tool descriptions and fixed harness texts, one set for every model (normative, embedded in the binary) | Agents building prompts and tools |
| [background/](background/) | Research and history (not normative) | Anyone asking *why* |

## Specs (normative)

| Spec | What it covers |
|---|---|
| [architecture](specs/architecture.md) | Modules, dependency rules, repository layout, state ownership, data flow, distribution |
| [interfaces](specs/interfaces.md) | Normative TypeScript contracts and the complete settings key set |
| [event-log](specs/event-log.md) | Event types, writer rules, blobs, resume, crash recovery, disk use |
| [providers](specs/providers.md) | AI SDK model layer, provider registry, strict tools, caching, retries, catalog |
| [agent-loop](specs/agent-loop.md) | Turn state machine, stop reasons, tool execution, interrupts, queue, guards |
| [tools](specs/tools.md) | Every built-in tool: input, behavior, limits, errors, edge cases |
| [permissions](specs/permissions.md) | Security model: boundary, rules, modes, safety checks, sandbox, taint, trust |
| [context](specs/context.md) | Prompt assembly, instruction files, mid-epoch instructions, compaction, caching |
| [receipts-budgets](specs/receipts-budgets.md) | Receipts, claim checker, cost formulas, budgets |
| [checkpoints](specs/checkpoints.md) | Snapshots, rewind, forks |
| [tui](specs/tui.md) | Terminal UI and headless mode: layout, rendering, input, keys, slash commands |
| [cli-config](specs/cli-config.md) | Commands, directories, settings, secrets, startup, `/login`, install |
| [platforms](specs/platforms.md) | Every Windows/macOS/Linux difference |
| [testing](specs/testing.md) | Test layers, test-quality rules, corpora, evals, release gates |
| [extensibility](specs/extensibility.md) | v0.2+: MCP, skills, hooks, subagents, ACP, LSP |

Acceptance criteria are named after their spec: `AC-ARCH`, `AC-LOG`, `AC-PROV`, `AC-LOOP`, `AC-TOOLS`, `AC-PERM`, `AC-CTX`, `AC-RCPT`, `AC-CKPT`, `AC-TUI`, `AC-CLI`, `AC-PLAT` (e.g. `AC-TOOLS-04`). IDs are permanent.

## Background (not normative)

Research and history behind the decisions. Useful for understanding *why*; never a source of requirements. If background disagrees with a spec, the spec wins.

| Document | What it is |
|---|---|
| [Feature research log](background/feature-research.md) | Per-feature evidence: sources checked, scenarios, decisions |
| [Design review 2026-10-11](background/design-review-2026-10-11.md) | A dated audit of the plan; parts describe earlier states |
| [Sources](background/sources.md) | Research sources |
| [Workflow audit 2026-10-19](background/workflow-audit-2026-10-19.md) | Baseline numbers for how the build workflow performs, and the cuts made |
