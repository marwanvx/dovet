# Build loop (for AI agents)

The owner starts every session with the same message, e.g. **"Continue building Dovet."** This file tells you what that means. Follow it step by step. The owner is not technical: never ask them to pick a task, read code or run commands, except in the "Owner steps" a task lists.

**Your memory is the repository, not the conversation.** Everything the next session needs is in these files:

| File | What it holds | Who writes it |
|---|---|---|
| `docs/plan/tasks/M<n>.md` | The task list of each milestone, with a status per task | Planner (step 4); you change only the `Status:` line |
| `docs/plan/tasks/PROGRESS.md` | Append-only log: one entry per session | You, at the end of every session |
| `docs/plan/tasks/QUESTIONS.md` | Questions only the owner can answer, and their answers | You add questions; the owner answers |
| git history and PRs | What was built, reviewed and merged | You |

## Every session, in order

### 1. Orient (read, don't change)
- Run `bun run next` and read its whole output: questions waiting for the owner, the last progress entries, the current milestone, the next task and the exact spec sections that task needs.
- `git status`, `git log --oneline -15`, open PRs and the CI state of `main` (`gh pr list`, `gh run list --branch main -L 3`).
- The current milestone is the first one in [roadmap](../plan/roadmap.md) whose task file has unfinished tasks (or has no task file yet).

### 2. Fix what's broken first
In this order; each one is the whole session's work if it applies:
1. `main` is red in CI → fix it (smallest change; a regression test if it was a real bug).
2. Uncommitted or half-done work from a crashed session → finish it or revert it, and say which in `PROGRESS.md`.
3. An open PR of yours with review findings or failing CI → fix it (step 6–7).

### 3. Use the owner's answers
If `QUESTIONS.md` has new answers: apply each one where it belongs (a spec change goes through the spec-change rules in [dev-workflow](dev-workflow.md); a plain choice goes into the task's notes) and move the question to "Answered".

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

**When the spec doesn't say:** don't guess and don't go searching beyond the task's Read list for an answer that isn't there. Add a question to `QUESTIONS.md` (what's missing, why it matters, your recommended answer, what you'll do meanwhile), set the task to `blocked`, and continue with the next unblocked task. If the gap is small and your recommendation is safe and easy to change, build it that way, mark it `ASSUMPTION` in the code and the question, and keep going.

### 7. Review with fresh eyes
Spawn a **fresh reviewer** (a subagent with no memory of your work; in Claude Code, the `reviewer` agent in `.claude/agents/reviewer.md`, which always runs on the strongest model even when a cheaper one builds) with: the task, its spec sections and the diff. It checks every criterion has a real test, and proves it: for each criterion it **breaks the code that implements it** (removes the check, flips the condition, returns early), confirms the tagged test now fails, then restores the code. A test that still passes with the feature broken is a finding. It also checks behavior matches the spec line by line, the module and dependency rules of [architecture](../specs/architecture.md) hold, and nothing outside the task changed. Fix its findings; repeat until it has none above "minor". Without subagents: open the PR and leave the review to the next session (step 2.3).

### 8. Ship
Open the PR (template filled: task, spec sections, criteria, assumptions). When CI is green on all three OSes and the review passed, **merge it** unless the task changes `docs/plan/` decisions (ADRs, the roadmap, product decisions in open questions) or has an Owner step; those wait for the owner (say so in `QUESTIONS.md`). Set the task's `Status:` to `done (#PR)`.

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
