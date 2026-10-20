# Dovet — instructions for AI agents working on this repo

Dovet is a terminal coding agent for Windows, macOS and Linux, written in TypeScript on Bun, that works with any model provider. Its promise: the agent can't hide what it did, what it cost, or what it was told.

**Current state:** M0 and M1 are done; M2 is in progress (`bun run next` says where). The owner is not technical: never ask them to choose tasks, read code or run commands (except a task's listed "Owner step"); when something is undecided, **decide it yourself** (build loop step 6); never stop to wait for the owner to answer.

## Start every session with this

```
bun install   # once per checkout
bun run next
```

It prints where the project stands, the task to work on and **the exact spec text that task needs**. Read it in full; it replaces "explore the docs". Then follow [docs/workflow/build-loop.md](docs/workflow/build-loop.md) step by step (it starts with fixing anything broken, and ends with a progress entry). Need another task's reading? `bun run next M0-03`.

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

## Claude Code helpers

- `.claude/hooks/no-attribution.ts` blocks commits, PRs and GitHub comments that carry vendor attribution; `.claude/hooks/format.ts` runs Biome on every edited file. `.claude/hooks/stop-gate.ts` won't let a session finish while changed code fails `tsc -b` or Biome; fix what it reports. `attribution` in `.claude/settings.json` turns off Claude Code's own trailers.
- `bun run auto [n]` (owner's command) builds n tasks unattended, one fresh `claude -p` session each (auto permission mode, Sonnet builds, $20 cap per run); it stops on a failure, a missing progress entry or a task that needs the owner. Each run is logged to `auto-runs.log`. In such a run nobody answers questions: decide, record, ship, stop.
- `/ship-task <id>` runs build loop steps 8–9 (PR, CI on three OSes, merge, status line, progress entry).
- The `plan-checker` agent does build loop step 4's fresh check of a milestone's task list; the `reviewer` agent does step 7.

## Rules that always apply

- **Owner rules (2026-10-13).** Dovet is the owner's provider-neutral product. No vendor attribution anywhere: no `Co-Authored-By` trailers, "Generated with …" lines or session links in commits, PRs or GitHub comments. Commits use the owner's GitHub noreply identity (`Marwan <154838093+marwanvx@users.noreply.github.com>`, via `GIT_AUTHOR_*`/`GIT_COMMITTER_*`), never a personal email and never `git config user.*`: the repository is public. Tests use the `nvidia` provider or made-up names (`example`) as examples. NVIDIA is the first provider; Anthropic is not planned unless the owner adds it (QUESTIONS Q23, M4-12).

- **Specs are the source of truth.** A spec that is unclear, incomplete or contradicts another: decide the best answer, record it and write it into the spec in the same PR (build loop step 6).
- **Every requirement lives in its feature's spec.** If you change `docs/plan/` or the user journeys, or add a `[SPIKE-n]`/ADR reference, run `bun run docs:boxes`. After any docs change, `bun run docs:check` must pass.
- **Never use a library or provider API from memory.** Verify against the installed package's types first, then current docs (Context7 `resolve-library-id` + `query-docs`; DeepWiki for how an open-source repo works). Check the traps table below first.
- **Every turn resends the whole conversation.** Make independent reads and searches in one turn; search, then read only the lines you need; pipe long output through `tail -n 60`; never read a whole spec (a hook refuses it: `bun run next` printed your sections with their line ranges).
- **Tests first, and real tests** (`docs/specs/testing.md` "Test-quality rules"): tag each with its criterion (`// spec: AC-TOOLS-04`), run it and see it fail before implementing, test what a user would see, don't fake the thing being tested. Never weaken a test or a criterion to make it pass; one that measurement shows is wrong changes only with that evidence in QUESTIONS.md, never by asking the owner.
- **No new runtime dependency** without an entry in ADR-15 (`docs/plan/decisions.md`).
- TypeScript strict; no `any`; zod-parse every external input; no floating promises; no catch-and-ignore.
- **Module boundaries and state ownership** (`docs/specs/architecture.md`): tools return effects and never change session state; no module-level mutable state, no `process.chdir`, no `process.env` writes; only `cli/main.ts` touches `process.*`.
- **Provider-neutral:** provider differences are registry data or a provider module (`docs/specs/providers.md`), never branches in core logic.
- A new user-visible feature updates `docs/product/user-journeys.md`.
- Copied code keeps its license notice (e.g. vendored pi-tui; listed in `THIRD_PARTY_NOTICES`) and the PR says so.
- **Few comments** (owner rule): only a non-obvious *why*, a workaround, a security-critical line or a `// spec:` tag; never restate the code; a file header is one line at most.
- No abstraction until three real uses exist. PRs under ~400 changed lines (tests excluded). One task per session.
- `bun run check` must pass before you report done. On the owner's Linux machine, `test/platform/sandbox` fails on `main` too (an AppArmor user-namespace restriction), and so do the SPIKE-5 file-fallback and ripgrep download tests; don't chase those, CI on three OSes decides.
- Report in plain words: what changed, which acceptance criteria now pass, what's not done, and any question you decided yourself (with your answer). Show a check's output instead of saying it passed; a check you couldn't run is reported as not run.

## Traps already hit (what you remember → what's true here)

| Remembered | True in this repo |
|---|---|
| `bun test` type-checks | It doesn't: run `bun run check` (or `bunx tsc --noEmit -p .`) |
| `Bun.spawnSync` is fine in tests | It blocks the event loop and deadlocks the in-process fixture server: spawn async |
| `stat().ino` is a usable number | 64-bit Windows file IDs lose bits as doubles: `stat(p, { bigint: true })` |
| Bun's `toMatchObject` only reads | It mutates the received object: assert fields directly |
| A `stop`/`end_turn` finish has no tool calls | Providers emit tool calls under it: handle the calls whatever the finish reason |
| Same-millisecond ULIDs sort in order | Their random tails sort backwards half the time: use the monotonic generator |
| Invisible Unicode can be typed into a test | Editing tools mangle it: write `\u{…}` escapes |
| A test can assert a spec string via its constant | That can't catch a mutation: pin the literal text |
| `dovet -p --output-format json` | The flag is `--output json`; with no settings, pass `--model` |
| sandbox-runtime takes `allowWrite` on Windows | It throws: leave `allowWrite` undefined there |
