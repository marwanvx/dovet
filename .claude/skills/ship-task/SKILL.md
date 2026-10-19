---
name: ship-task
description: Ship a finished, reviewed Dovet task (build loop steps 8 and 9): open the PR from the template, record the status line and progress entry in it, wait for CI on Linux, macOS and Windows, then merge. Use only after the fresh review has no findings above minor.
disable-model-invocation: true
argument-hint: "<task id, e.g. M1-10>"
---

Ship task `$ARGUMENTS`. Follow [build loop steps 8–9](../../../docs/workflow/build-loop.md); where this file and the build loop differ, the build loop wins.

## Before you start
- The current branch is `task/$ARGUMENTS`, everything is committed, and the reviewer's findings are fixed.
- `bun run check` passes, apart from tests that also fail on `main` on this machine (name them in the PR).
- No vendor attribution anywhere: no `Co-Authored-By`, no "Generated with", no session links (owner rule; a hook blocks these).

## 1. Open the PR
1. `git push -u origin task/$ARGUMENTS`
2. Fill `.github/PULL_REQUEST_TEMPLATE.md`: the task id and title; the spec sections `bun run next $ARGUMENTS` prints; each acceptance criterion with its tagged test and the failing output from before the implementation; the questions decided in `docs/plan/tasks/QUESTIONS.md` (by number); third-party code or "none".
3. Write the body to a file in the scratchpad and run `gh pr create --base main --head task/$ARGUMENTS --title "$ARGUMENTS: <title>" --body-file <file>`.

## 2. Record it in the same PR
1. In `docs/plan/tasks/M<n>.md`, set the task's `- **Status:**` line to `done (#<n>)`.
2. Append to `docs/plan/tasks/PROGRESS.md`, in the format of the entries above it:
   ```
   ## <today> — $ARGUMENTS <title>
   Done: <one or two lines>. PR: #<n> (merged | waiting for owner).
   Review: <tier>, <rounds> rounds, <n> fixed, <n> dropped, <n> logged to FOLLOWUPS.
   Learned: <quirks, decisions, workarounds the next session needs; open spec-change PRs>.
   Next: <next task id>, or what's blocking.
   ```
3. `bun run docs:check && bun run spec:coverage`, commit, push to the same branch. Never open a separate status PR.

## 3. Wait for CI
Run `bun .claude/skills/ship-task/scripts/wait-ci.ts <pr number>` in the foreground, with a 60-minute timeout, and do nothing else until it returns: no `sleep`, no repeated `gh run view` (each poll is a model round trip). It prints each job's result and exits 0 only when every check passed.
- A failure: read its log (`gh run view <run id> --log-failed`), fix it on the branch, push, and wait again. If it is a known flaky test from `PROGRESS.md` (for example the Windows EBUSY cleanup), re-run once with `gh run rerun <run id> --failed` and say so in the progress entry.
- Never merge on red.

## 4. Merge or wait for the owner
- If the task changes `docs/plan/` decisions (ADRs, roadmap, product decisions) or has an **Owner step**, don't merge. Set the status line to `waiting for owner (#<n>)`, say so in the progress entry, push, and stop.
- Otherwise run `gh pr merge <n> --merge --delete-branch`, then `git switch main && git pull`.

## 5. Tell the owner
At most three plain sentences: what got done, what's next, and whether anything waits for them.
