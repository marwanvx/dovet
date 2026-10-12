# Build loop (for AI agents)

The owner starts every session with the same message, e.g. **"Continue building Dovet."** This file tells you what that means. Follow it step by step. The owner is not technical: never ask them to pick a task, read code or run commands, except in the "Owner steps" a task lists.

**Your memory is the repository, not the conversation.** Everything the next session needs is in these files:

| File | What it holds | Who writes it |
|---|---|---|
| `docs/plan/tasks/M<n>.md` | The task list of each milestone, with a status per task | Planner (step 4); you change only the `Status:` line |
| `docs/plan/tasks/PROGRESS.md` | Append-only log: one entry per session | You, at the end of every session |
| `docs/plan/tasks/QUESTIONS.md` | Questions the specs didn't answer, with the answer that was chosen | You write both the question and the answer; the owner may override |
| git history and PRs | What was built, reviewed and merged | You |

## Every session, in order

### 1. Orient (read, don't change)
- Run `bun run next` and read its whole output: owner overrides to apply, the last progress entries, the current milestone, the next task and the exact spec sections that task needs.
- `git status`, `git log --oneline -15`, open PRs and the CI state of `main` (`gh pr list`, `gh run list --branch main -L 3`).
- The current milestone is the first one in [roadmap](../plan/roadmap.md) whose task file has unfinished tasks (or has no task file yet).

### 2. Fix what's broken first
In this order; each one is the whole session's work if it applies:
1. `main` is red in CI → fix it (smallest change; a regression test if it was a real bug).
2. Uncommitted or half-done work from a crashed session → finish it or revert it, and say which in `PROGRESS.md`.
3. An open PR of yours with review findings or failing CI → fix it (step 6–7).

### 3. Apply the owner's overrides
You answer your own questions (step 6), so there is normally nothing to wait for. `bun run next` lists any answered question where the owner added an `**Override (owner, <date>):**` line. Apply each override where it belongs (a spec change goes through the spec-change rules in [dev-workflow](dev-workflow.md); a plain choice goes into the task's notes), change the code that followed the old answer, and add an `**Override applied:**` line saying what changed. Anything left under "Waiting for the owner" is something only the owner can do (an account, money, a key); don't start work that depends on it.

### 4. Make sure the milestone has a plan
Every v0.1 milestone (M0–M5) already has a task list. **When a milestone's first task is about to start,** this session first re-checks that milestone's list against what earlier milestones actually built (a changed interface, a spike answered "no", work moved earlier or later): it adjusts, splits or adds tasks, keeps every acceptance criterion placed exactly once, commits the update with a PR, then stops. For a milestone with no task file yet (v0.2 and later), this session plans it, then stops:
- Read [roadmap](../plan/roadmap.md) (that milestone and its exit evidence), [open-questions](../plan/open-questions.md), and the "Before you build" box of every spec the milestone builds. Not whole specs.
- Write the task file in the format of [tasks/M0.md](../plan/tasks/M0.md): tasks in build order, each with **Depends on**, **Read** (links whose text names the exact sections, as quoted headings or § numbers, e.g. a link labeled `tools §5 and "Common rules"`, so `bun run next` can print them), **Build** (files per [architecture "Repository layout"](../specs/architecture.md)), **Done when** (acceptance-criterion IDs or a concrete test), **Owner step** if any. Each task fits one PR under ~400 changed lines; blocking spikes come first; every acceptance criterion of the milestone is in exactly one task; the last task is the exit check.
- **Check the plan with a fresh reviewer** (a subagent if your tool has them; otherwise the next session does it before building): every criterion placed once, dependencies in order, no task needing a spec that isn't in its Read list, and `bun run next <task>` prints real sections for every task (no "couldn't find" lines). Fix what it finds. Commit the task file to `main` with a PR.

### 5. Pick the task
The first task in the current milestone's file whose `Status:` is `todo` and whose **Depends on** tasks are all `done`. Skip tasks `blocked` on an unanswered question. If every remaining task is blocked, write a clear summary for the owner and stop. If the milestone's tasks are all `done`, do its exit-check task.

Set its `Status:` to `in-progress` and start a branch `task/<id>`.

### 6. Build it
1. Read what `bun run next` printed for the task (its **Read** sections and their "Before you build" boxes); open a linked doc only when those sections point to it for this task. Nothing else unless a test failure points you there.
2. If the task depends on an unresolved spike, resolve the spike first (its "How to resolve" in [open questions](../plan/open-questions.md), for real, with code and runs); record the result in open questions and [background/feature-research.md](../background/feature-research.md); apply its fallback if the answer is no.
3. Write the tests for the task's criteria (`// spec: AC-xx-yy`) following the test-quality rules in [testing](../specs/testing.md), **run them before implementing and keep the failing output** (it goes in the PR: a test that passes before the code exists tests nothing), then implement until they pass. Verify every library or provider API against the installed types or official docs.
4. `bun run check` must pass.

**When the spec doesn't say:** don't guess and don't go searching beyond the task's Read list for an answer that isn't there. **Answer it yourself.** Choose the best answer (the one that follows the product principles and the surrounding specs, and is safest and easiest to change later). Write an entry under "Answered" in `QUESTIONS.md`: what was missing, why it matters, your answer and why. Put the answer into the spec in a separate spec-change PR ([dev-workflow](dev-workflow.md)), or, while that PR is pending, build it that way and mark the code `ASSUMPTION (QUESTIONS Qn)`. Never set a task to `blocked` or stop just to wait for the owner. Only if the answer needs something no agent can provide (an account, money, a secret, a physical device) does the question go under "Waiting for the owner"; then build everything that doesn't depend on it.

### 7. Review with fresh eyes
Spawn a **fresh reviewer** (a subagent with no memory of your work; in Claude Code, the `reviewer` agent in `.claude/agents/reviewer.md`, which always runs on the strongest model even when a cheaper one builds) with: the task, its spec sections and the diff. It checks every criterion has a real test, and proves it: for each criterion it **breaks the code that implements it** (removes the check, flips the condition, returns early), confirms the tagged test now fails, then restores the code. A test that still passes with the feature broken is a finding. It also checks behavior matches the spec line by line, the module and dependency rules of [architecture](../specs/architecture.md) hold, and nothing outside the task changed. Fix its findings; repeat until it has none above "minor". Without subagents: open the PR and leave the review to the next session (step 2.3).

### 8. Ship
Open the PR (template filled: task, spec sections, criteria, assumptions). When CI is green on all three OSes and the review passed, **merge it** unless the task changes `docs/plan/` decisions (ADRs, the roadmap, product decisions in open questions) or has an Owner step; those wait for the owner (say so in the progress entry). Set the task's `Status:` to `done (#PR)`.

**Docs-only changes don't wait for CI** (owner rule, 2026-10-12): a commit or PR that touches only `docs/` and Markdown files (status lines, progress entries, questions, wording) is merged as soon as `bun run docs:check` and `bun run spec:coverage` pass locally. Anything that touches code, tests, scripts, workflows or `package.json` still waits for green CI.

### 9. Hand off
Append to `PROGRESS.md`:
```
## <date> — <task id> <title>
Done: <one or two lines>. PR: #<n> (merged | waiting for owner).
Learned: <anything the next session must know: a quirk, a decision, a workaround>.
Next: <the next task id>, or what's blocking.
```
Then tell the owner, in three plain sentences at most: what got done, what's next, and whether anything waits for them.

**One task per session.** When it's shipped, stop, even if context is left: a fresh session does the next one better. Exception: if your tool can run subagents and the owner said "keep going", act as an orchestrator: run steps 5–9 for each task in its own fresh subagent, keep only the summaries in your session, and stop at a blocked task, an Owner step, the end of the milestone, or after 5 tasks.

## Never
- Never edit a spec to make code pass; specs change only through [dev-workflow](dev-workflow.md) spec-change rules.
- Never remove or weaken a test or acceptance criterion to finish a task.
- Never mark a task `done` without merged code and green CI.
- Never start a second task while one is `in-progress`.
- Never work on anything outside the current milestone, even if it looks quick.
