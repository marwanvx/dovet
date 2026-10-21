# Workflow audit, 2026-10-19

Background, not requirements. Raw sources only: Claude Code session logs (`~/.claude/projects/…dovet`, 33 sessions, M1-09 → M1-23b), the OpenCode database (277 sessions, M1-23c → M2-04 and the re-review/fix wave), the Antigravity and OpenCode fix-run logs, GitHub PR and CI history (146 PRs, 452 runs), and `git diff --numstat` of every merge. The scripts and raw exports are kept outside the repo, in `~/.local/share/dovet-audit/` on the owner's machine.

## Baseline: the last 20 tasks (M1-19 → M2-04)

| Measure | Value |
|---|---|
| Median time, first session start → task PR merged | 70 min (M1-32: 546) |
| Median tokens per task, build sessions incl. reviewers (cache reads included) | 22.5 M |
| Tokens spent on later re-review and fix runs | 600 M, against 706 M to build the same 20 tasks |
| Tasks that needed a fix-up PR after merge | 11 of 20 (0.55 per task, 135–2 968 changed lines each) |
| Bookkeeping PRs (≤ 12 lines, status and progress only) | 1.7 per task; 56 of 142 merged PRs overall |
| CI runs on these tasks' branches / re-runs | 100 / 21 |
| `main` red (failed push run until the next green one) | 22.1 h over 12 spells; 17 of 109 push runs failed |

## Where the time goes

OpenCode build sessions (free models): of each session, the model's wait before its first token was 40–75 % (M1-32: 422 of 561 minutes), tool time (tests, CI, reviewers) most of the rest. A task took 110–386 model messages, and each one pays that wait and re-reads the whole context. Claude sessions (Sonnet, M1-21): 19 of 38 minutes model, 13 waiting on CI.

**Biggest bottleneck: quota and free-tier model latency, multiplied by the number of round trips.** The process is what sets the round-trip count, so that's the lever: anything that adds messages without adding work costs the most.

## Rules against the logs (32 build sessions)

| Rule | Followed | Effect seen |
|---|---|---|
| Run `bun run next` first | 32/32 | Works; 7–10 k tokens of spec text per session |
| Tests run failing before implementing | 14/32 | Not enforced; the `tests` reviewer lens is the backstop |
| `bun run check` before the PR | 24/32 | CI catches the rest |
| Verify library APIs with Context7/DeepWiki | 5/32 | Mostly installed types instead; rule is aspirational |
| PR under ~400 non-test lines | 16/37 code PRs | Mean 459 code + 527 test lines; never blocked by a review |
| New user-visible feature updates `user-journeys.md` | 0/32 | Never done, including M1-28 headless mode |
| Reviewer breaks code to prove tests (mutation) | Claude reviewers ran tests in 17/18 sessions; OpenCode reviewers in 2/14 | OpenCode reviewer commands were silently denied 10-15 → 10-16, which is why the re-review wave found blockers |
| Fixes after the first review | Claude 1/18 sessions; OpenCode 13/14 | Claude's Opus reviewer rarely found anything to act on; the free models' own reviews found work every time |
| Status line and progress entry in a separate PR | 27/32 sessions opened ≥ 2 PRs | Pure overhead: an extra PR, an extra CI run on the PR and another on `main`, ~10 tool calls |
| Wait for CI | median 9 polling calls per session (`sleep 60/240`, repeated `gh run view`) | Each poll is a model round trip; `wait-ci.ts` already existed but the skill said "in the background" |

Instruction files loaded per session: AGENTS.md ~1.8 k tokens, build-loop.md ~3.1 k, `bun run next` 7–10 k, a reviewer file 0.5–1.3 k. That's small next to 20–50 M tokens per task. Rule text is not the cost; round trips are.

## Duplication

Three runners (`scripts/auto.ts` committed; `auto-oc.ts`, `auto-agy.ts` local) of 377–418 lines share 142–193 lines pairwise; `parseArgs`, `decide`, `lastEntry` and `describeEvent` exist three times. Reviewer instructions exist three times (Claude agent, OpenCode agent, Antigravity skill) and the ship step three times. The one-off re-review and fix runners (`auto-review.ts`, `auto-fix.ts`, about 1 550 lines in two copies) finished their queue on 2026-10-19. Five tracked files carry local skip-worktree overrides for the OpenCode wording, which hid a build-loop change from git twice in one session.

## Cuts made

1. **One PR per task.** The status line and progress entry are committed to the task's own PR (build loop step 8, the ship skill). Evidence: 1.7 bookkeeping PRs per task, 50 PR CI runs plus a `main` run for each.
2. **One blocking CI wait.** `wait-ci.ts` in the foreground, with no polling. Evidence: a median of 9 polling round trips per session.
3. **Re-review and fix runners removed** (local only, done with the owner's agreement). Their 15 reports and logs are kept as the reviewer eval set.

## Recommended, not cut (evidence not yet clear enough)

- **One runner core.** Move `parseArgs`, `decide`, `lastEntry` and the event feed into one module that each runner imports; that would remove about 300 duplicated lines and the three-way rule edits.
- **The 400-line PR rule:** either let CI enforce it or drop it; as text it is broken in most PRs.
- **The user-journeys and Context7 rules:** either make them checks or drop them.
- **The skip-worktree overrides:** replace them with one neutral committed wording, so no tracked file needs a local override.
- **The model mix:** the review rules from #145 cap rounds; the next lever is cutting messages per task (fewer, larger reads and edits), which matters most on free models.

## Recheck, 2026-10-21

Run on the next 7 merged tasks (M2-05, M2-05b, M2-06, M2-07, M2-08, M2-08b, M2-09; M2-05b is the sandbox half of M2-05) with the same scripts (raw exports in `~/.local/share/dovet-audit/2026-10-21/`). Every one of them was built by an unattended Claude Code session; the baseline tasks were mostly OpenCode free models, so this is a before/after of the whole setup (one PR per task, one blocking CI wait, no re-review runners, review tiers), not of one cut.

| Measure | Baseline (20 tasks) | Now (7 tasks) |
|---|---|---|
| Median time, first session start → task PR merged | 70 min (M1-32: 546) | 73 min (M2-05b: 576, M2-06: 546; the other five 31–99) |
| Median tokens per task, build sessions incl. reviewers (cache reads included) | 22.5 M (mean 35.3 M) | 20.9 M (mean 24.4 M; 12.8–38.2 M) |
| Tokens spent on later re-review and fix runs | 600 M, against 706 M to build | 0 (no re-review wave has run on these tasks yet) |
| Tasks that needed a fix-up PR after merge | 11 of 20 (0.55 per task) | 0 of 7 (0 per task) |
| Bookkeeping PRs (≤ 12 lines, status and progress only) | 1.7 per task | 0 per task |
| CI runs on the tasks' branches / re-runs | 100 / 21 (5.0 and 1.05 per task; median 5) | 51 / 2 (7.3 and 0.29 per task; median 3) |
| `main` red (failed push run until the next green one) | 22.1 h over 12 spells; 17 of 109 push runs failed | 0 h; 0 of the 20 push runs since 2026-10-19 20:00 UTC failed (one 27-minute spell on 10-19 19:15, before M2-05 started) |

What the numbers say:
- **Better:** fix-up PRs, bookkeeping PRs, hours `main` was red, re-runs, rework tokens, mean tokens per task. The bookkeeping and CI-wait cuts did what the baseline predicted (0 bookkeeping PRs; the bookkeeping total of 56 merged PRs overall has not grown).
- **Not better:** median time (70 → 73) and mean CI runs per task (5.0 → 7.3). Both come from two deep-tier tasks that needed a "rethink" session after three review rounds: M2-05b (576 min, 9 CI runs) and M2-06 (546 min, 21 CI runs, 13 of them red, including Bun segfaults and hangs on Windows with real local sockets that only a temporary CI job isolated). The five other tasks took 31–99 min and 3–9 CI runs each, and every standard-tier task (M2-08, M2-08b, M2-09) finished in one review round.
- **Caveats:** the baseline's fix-ups were found by a re-review wave days after the merges; these tasks merged 4–48 hours ago, so 0 fix-ups may rise. Tokens are not comparable across model families. M2-09's 9 CI runs include a flaky memory test (F16) and a Windows timing limit.
- **Guardrail (2026-10-20):** fix-up PRs per task are 0, below 0.55, so standard tasks keep one reviewer.
- **Follow-up filed:** F17 (CI runs per task rose on deep tasks).

Recheck again after the next 5 tasks, with `TASKS=<ids> bun ../baseline.ts` (the task list now comes from the environment).

## Reviewer eval from past bugs, 2026-10-21

Question: does the `reviewer` agent find bugs that the 2026-10-16/17 re-review wave found after merge, and does `effort: medium` find more than `effort: low`?

**Cases.** The 15 re-review reports in `.agents/review-backlog/` (the copies in `.opencode/review-backlog/` carry the same findings) give 10 cases with a blocker or major: M1-24, M1-25, M1-26, M1-28, M1-29, M1-32, M2-01, M2-02, M2-03, M2-04. The other five (CI-fix-108, M1-23c, M1-27, M1-30, M1-31) found nothing above minor, and M2-plan-check is a plan check; none is a case. A case is the task's own PR as the reviewer would have seen it: the PR's first parent checked out, the PR's diff applied and uncommitted, in a fresh `git init` copy (no later history to read, no report). "Known bug" is a blocker or major from the report.

| Set | Cases |
|---|---|
| Tuner may see | M1-24, M1-25, M1-26, M1-28, M2-01 |
| Held out | M1-29, M1-32, M2-02, M2-03, M2-04 |

No tuning was done (the reviewer prompt is unchanged), so the held-out set is clean and the tuner cases were not run: the budget of this run was $10.

**Held-out cases.** Each run was one `reviewer` subagent given the task id and the checkout (all three lenses, targeted tests only), `effort` set per run. Merge commits: M1-29 `abfd607`, M1-32 `0d6d85c`, M2-02 `2cee829`, M2-03 `82e95b2`, M2-04 `a3c5797`.

| Case (known bugs) | low found | medium found |
|---|---|---|
| M2-04 (2: `redact.ts` offsets cut after a non-BMP character, taint never applied in headless) | 1: taint | 1: taint |
| M2-02 (3: `decide.ts:312` assignment prefix hides a dynamic command, bare `xargs` auto-allows, no test for `lifted:false` while tainted) | 0 | 2: assignment prefix, missing test |
| M1-32 (1 blocker: `--repair` renders with no earlier history, `build.ts:45`) | 0 | 0 |
| M1-29 (2 blockers: repair-epoch test, stored-tools test) | 2 | 2 (and a torn-line sidecar bug no report lists, not verified) |
| M2-03 (2: Done-when unmet, level 2 unreachable behind MXC) | 2 | 1: Done-when |
| **Total (10 known)** | **5** | **6** |
| Reviewer tokens (as reported, cache reads excluded) | 289,695 | 370,829 (+28%) |

The first low run on M2-04 cost $0.53 of API spend; the nine runs together about $7.3.

What the numbers say (a small sample: 5 cases, 10 bugs, one run each):
- Both levels find what is visible by reading: code nothing calls, a Done-when with no real test, a test that cannot fail, fail-open `catch`. All 9 runs reported wiring gaps.
- Both miss what needs an input to be tried: the non-BMP offsets in `redact.ts`, `--repair` losing history, bare `xargs`. Neither level ever ran such an input, so a higher effort on the same prompt did not change this class.
- Medium found 6 of 10, low 5 of 10: medium gained 2 on M2-02 and lost 1 on M2-03, so one bug in total, which one run per case cannot tell from chance. It cost about 28% more tokens and 3 to 5 times the wall time (about 4 to 7 minutes against 1 to 2).
- The bugs are of two kinds: the unreached ones above, and a Done-when with no real proof. A prompt change aimed at the first (try one hostile input per criterion, say it in the report) is the lever to test next, on the five tuner cases.

**Decision.** The reviewer stays at `effort: low` (`.claude/agents/reviewer.md` unchanged): one more bug in ten for 28% more tokens and several times the wait is not a result. `security-reviewer` stays at `medium` (its lens is the hostile-input one, and this eval did not test it). Re-run this eval when the reviewer prompt changes, on the tuner cases first.

Reproduce a case: `git archive <merge>^1 | tar -x -C <dir>`, `git init` and commit there, `git diff <merge>^1 <merge> | git apply` in `<dir>`, link `node_modules`, then ask the `reviewer` agent to review the task in `<dir>`.

Runs that went wrong: reviewers' `bun run check` (300 s) never finishes on a copy; ask for targeted tests only. The copies predate `REVIEW.md`, so the reviewers used the report format in the brief.
