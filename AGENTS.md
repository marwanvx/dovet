# Dovet — instructions for AI agents working on this repo

Dovet is a terminal coding agent for Windows, macOS and Linux, written in TypeScript on Bun, that works with any model provider. Its promise: the agent can't hide what it did, what it cost, or what it was told.

**Current state:** planning is complete; building starts at milestone M0. The owner is not technical: never ask them to choose tasks, read code or run commands (except a task's listed "Owner step"); when something is undecided, **decide it yourself** (best answer, recorded in `docs/plan/tasks/QUESTIONS.md`); never stop to wait for the owner to answer.

## Start every session with this

```
bun install   # once per checkout
bun run next
```

It prints where the project stands (owner overrides to apply, the last progress entries, the current milestone), the task to work on, and **the exact spec text that task needs**. Read that output in full; it replaces "explore the docs". Then follow [docs/workflow/build-loop.md](docs/workflow/build-loop.md) step by step (it starts with fixing anything broken, and ends with a progress entry). Need another task's reading? `bun run next M0-03`.

## Where things are

| Folder | What it is |
|---|---|
| `docs/workflow/` | How you work: the build loop (every session), the dev-workflow rules (every change) |
| `docs/plan/` | Roadmap, decisions (ADRs), open questions (spikes), `tasks/` (task lists, progress log, questions for the owner) |
| `docs/specs/` | What to build. **Normative.** Each spec starts with a generated "Before you build" box: milestone, decisions, open questions with fallbacks, user journeys |
| `docs/product/` | Vision, principles, user journeys |
| `docs/prompts/` | System prompts and tool descriptions. **Normative**, embedded in the binary; changing them is a spec change |
| `docs/background/` | Research and history. Never requirements; if it disagrees with a spec, the spec wins |

Code, tests and files go where `docs/specs/architecture.md` "Repository layout" says.

## antislop skills

Six antislop skills (MIT, https://github.com/miqdadbadjuber/anti-slop, v3.2.20; license in `.claude/skills/ANTISLOP-LICENSE`) are installed in `.claude/skills/`. Read the skill file directly when the work matches:
- Core filter, read first: `.claude/skills/antislop/SKILL.md`
- Code comments: `.claude/skills/antislop-code/SKILL.md` (use it with the "Few comments" rule below)
- Copy and text (docs, CLI messages, README): `.claude/skills/antislop-copywriting/SKILL.md`
- People, UI, mobile layout (docs site, install page): `antislop-human`, `antislop-ui`, `antislop-layoutmobile` in the same folder

Usage mode is `during` (QUESTIONS Q13): never ask the owner which mode; say `antislop active: during (project instruction).` once. If antislop conflicts with a spec or this file, the spec and this file win.

## Claude Code helpers

- `.claude/hooks/no-attribution.ts` blocks commits, PRs and GitHub comments that carry vendor attribution; `.claude/hooks/format.ts` runs Biome on every edited file. `.claude/hooks/stop-gate.ts` won't let a session finish while changed code fails `tsc -b` or Biome; fix what it reports. `attribution` in `.claude/settings.json` turns off Claude Code's own trailers.
- `bun run auto [n]` (owner's command) builds n tasks unattended, one fresh `claude -p` session each (auto permission mode, Sonnet builds, $20 cap per run); it stops on a failure, a missing progress entry or a task that needs the owner. Each run is logged to `auto-runs.log`. In such a run nobody answers questions: decide, record, ship, stop.
- `/ship-task <id>` runs build loop steps 8–9 (PR, CI on three OSes, merge, status line, progress entry).
- The `plan-checker` agent does build loop step 4's fresh check of a milestone's task list; the `reviewer` agent does step 7.

## Rules that always apply

- **Owner rules (2026-10-13).** Dovet is the owner's provider-neutral product. No vendor attribution anywhere: no `Co-Authored-By` trailers, "Generated with …" lines or session links in commits, PRs or GitHub comments. Tests use the `nvidia` provider or made-up names (`example`) as examples. NVIDIA is the first provider; Anthropic is not planned unless the owner adds it (QUESTIONS Q23, M4-12).

- **Specs are the source of truth.** If two specs disagree, or a spec is unclear or missing something, don't guess and don't search for an answer that isn't there: answer it yourself: pick the best answer, write the question and your answer in `docs/plan/tasks/QUESTIONS.md` under "Answered", fix the spec through the spec-change rules, and keep going (build loop step 6). The owner can override an answer later; don't wait for them.
- **Every requirement lives in its feature's spec.** If you change `docs/plan/` or the user journeys, or add a `[SPIKE-n]`/ADR reference, run `bun run docs:boxes`. After any docs change, `bun run docs:check` must pass.
- **Never use a library or provider API from memory.** Verify against the installed package's types first, then current docs: the Context7 MCP (`resolve-library-id`, then `query-docs`) for library docs, DeepWiki (`ask_wiki_question`) for how an open-source repo works, and the TypeScript LSP to jump to definitions instead of reading whole files.
- **Tests first, and real tests** (`docs/specs/testing.md` "Test-quality rules"): tag each with its criterion (`// spec: AC-TOOLS-04`), run it and see it fail before implementing, test what a user would see, don't fake the thing being tested. Never weaken a test or a criterion to make it pass.
- **No new runtime dependency** without an entry in ADR-15 (`docs/plan/decisions.md`).
- TypeScript strict; no `any`; zod-parse every external input; no floating promises; no catch-and-ignore.
- **Module boundaries and state ownership** (`docs/specs/architecture.md`): tools return effects and never change session state; no module-level mutable state, no `process.chdir`, no `process.env` writes; only `cli/main.ts` touches `process.*`.
- **Provider-neutral:** provider differences are registry data or a provider module (`docs/specs/providers.md`), never branches in core logic.
- A new user-visible feature updates `docs/product/user-journeys.md`.
- Copied code keeps its license notice (e.g. vendored pi-tui; listed in `THIRD_PARTY_NOTICES`) and the PR says so.
- **Few comments.** Comments only where the code can't say it: a non-obvious *why*, a workaround, a security-critical line, a `// spec:` tag. Never restate the code, narrate steps, or repeat what a name or type says; a file header is one line at most. Comments cost tokens in every later session (owner rule).
- No abstraction until three real uses exist. PRs under ~400 changed lines (tests excluded). One task per session.
- `bun run check` must pass before you report done. On the owner's Linux machine, `test/platform/sandbox` fails on `main` too (an AppArmor user-namespace restriction), and so do the SPIKE-5 file-fallback and ripgrep download tests; don't chase those, CI on three OSes decides.
- Report in plain words: what changed, which acceptance criteria now pass, what's not done, and any question you decided yourself (with your answer).
