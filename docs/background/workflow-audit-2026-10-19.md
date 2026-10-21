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
