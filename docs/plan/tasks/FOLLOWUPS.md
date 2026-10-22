# Follow-ups

Pre-existing bugs a review found in code its task didn't change ([build loop step 7](../../workflow/build-loop.md)). Open `blocker` and `major` entries are fixed first, oldest first (step 2.4); `minor` ones wait for a task that touches the same code.

Format:

```
### F<n> (<task that found it>): <short title>
- **Severity:** blocker | major | minor · `file:line`
- <what fails, the input that shows it, the class of bug>
```

When fixed, move the entry to "Fixed" and add `- **Fixed:** #<PR>`.

## Open

### F26 (M2-15): the policy's plan-file shortcut skips every path check, so each place that picks a plan file has to re-validate
- **Severity:** major · `src/policy/decide/decide.ts:123` and `:409-414`, `src/store/event-log/plan.ts` (`projectPlanDir`, `planFileAllowed`), `src/cli/headless-run.ts` (plan re-attach read, Dovet facts read)
- `t.path === env.planFile` returns before the protected-path, sensitive-file, outside-project and link checks, so M2-15 confines the plan file where it is chosen (`plan.directory`, a logged path on resume, a fork's copy). Three review rounds each found another way past that: `..` and `.git`, then `.dovet`/`.env` inside the project, then a link with a plan file's name pointing at a key (a link is now refused, with a test). The same class is still open: the session-plan-folder branch checks the path lexically only; the plan text is read for the re-attach and the facts with no sensitive-file check; Windows short names and alternate streams were read but not run.
- Fix at the layer that owns the rule: make the policy's plan-file exception only skip the "plan mode allows no edits" default, keep the protected/sensitive/link checks (the session's own plan folder under the data dir is already in `ownFiles`), and read plan text through the same checks as Read. Then drop most of `planFileAllowed`.

### F25 (M2-15): headless `ExitPlanMode` is denied, so a headless plan is never presented
- **Severity:** minor · `src/cli/headless-run.ts` (`decideFn`), `src/tools/plan-mode.ts:99`
- A scripted model that writes its plan and calls `ExitPlanMode` in `--permission-mode plan` gets `Permission denied: needs the user's answer` (interaction actions ask, headless denies). Tools §11.3 says headless returns the plan as the turn's result with a `plan` event, mode staying `plan`. Allow the call when the mode is `plan`, log `plan.presented`, and make the result the turn's text; the `plan` stream event waits for `--output stream-json`. `ExitPlanMode` is the only tool that reads `ctx.session.mode`, so the rebuild of the tool context after EnterPlanMode (`applyResultMode`) has no observable effect until then: add a test that ExitPlanMode called after EnterPlanMode in the same round is not told "Not in plan mode".

### F24 (F16 CI): two more Windows tests timed out on a slow runner
- **Severity:** major (second sighting, M2-15 CI run 39714803004: `headless-budget.test.ts` ×3 at 5,001 ms and `snapshots.test.ts` "a blob that is gone…" / "plan lists the paths…" at 5,004–5,218 ms with `git fast-import` failing and EBUSY on cleanup; all passed on a rerun of the same commit) · `test/platform/...` "Bash on every OS > Git Bash: 2>nul creates no nul file; Python prints non-ASCII" (5,002 ms, "killed 1 dangling process", then EBUSY removing its temp dir) and `src/checkpoints` "snapshot > works from a linked worktree, where .git is a file" (5,848 ms, `git init --bare` exited 143)
- `windows-latest`, CI run 39698593461 for #182 (a test-only change that touches neither). Both spawn real processes (Python, git) and hit Bun's 5 s default on a cold runner, the same class as F18. If either repeats, give it a longer limit with the measured time or remove the real process from it.

### F23 (M2-14 review): a forced compaction skips the compaction-thrash guard
- **Severity:** minor · `src/cli/headless-run.ts` (`compact-retry` branch; the auto path calls `guards.noteCompaction`)
- A first message that is itself over the threshold after a `context_exceeded` compaction is caught only by the second `context_exceeded` response, one paid request later. Run the same `noteCompaction` check after the forced `compactEpoch`, with a test.

### F3 (live test 2026-10-19): a fresh install refuses to run without a configured model
- **Severity:** minor · `src/cli/headless-run.ts:149`
- With an NVIDIA key and no settings file, `dovet -p "…"` exits 2 with "no model configured; set model in settings or --model". Pick a default NVIDIA model (the registry's) or name a working `--model` value in the message.

### F4 (live test 2026-10-19): the model retries Bash after the sandbox refused it
- **Severity:** minor · Bash tool result when the sandbox is unavailable
- On a machine where the sandbox can't start (Ubuntu AppArmor user namespaces), job 1 tried `bun test` 7 times, including with `dangerouslyDisableSandbox`, and every try errored. The result text should say plainly that this command can't run in this session, so the model stops.

### F6 (task F2 review): `--output json` `cost` on a resumed session is the session total, `usage` is this turn only
- **Severity:** minor · `src/cli/headless-run.ts:653` (`guards.cost` starts at the stored session cost)
- The tui "Headless mode" spec says `usage` and `cost` cover every request of the turn. On `--resume`/`--continue` `cost` also includes earlier turns (it is what the session budget compares against; the budget test relies on it). Decide which one the JSON field means (turn or session), write it in the spec and make both fields use the same scope; a separate turn-cost counter keeps the budget guard session-wide. Pre-existing.

### F7 (task F2 review): tokens of a request that fails or is aborted after its `usage` event are not counted
- **Severity:** minor · `src/cli/headless-run.ts` (the `usage` event only feeds the cache warning; `done` is the accounting point)
- A provider may bill a request that ended in an error or an abort; its `usage` event is dropped from `usage` and `cost`. Count the last `usage` event of a request that has no `done`, with a test. Pre-existing in cost, new in `usage`.

### F8 (M2-05 security review): the trust hash and the settings load read the files separately
- **Severity:** minor · `src/store/config/trust.ts` (`projectConfigHash`), `src/store/config/load.ts`
- A project file rewritten between the hash read and the load is judged by the earlier hash. It needs write access to the folder at that moment, and the next reload re-resolves trust, so the window is one startup. Fix: hash the exact text `loadSettings` parses.

### F10 (F9 security review): a symlinked `settings.local.json` is written through, and then recorded as personal
- **Severity:** minor · `src/store/config/atomic.ts:6` (follows the link), `src/store/config/trust.ts` (`localSettingsRepoSupplied` lstats `.dovet` and `.claude` but not the file)
- A repo-supplied untracked `.dovet/settings.local.json -> ~/.config/dovet/settings.json`: `saveLocalRule` writes the rule into the user's global settings, and the text then matches the record. Fix: treat a symlinked local file as repo-supplied and have `saveLocalRule` refuse to write through it. Pre-existing for the write; the record is new.

### F11 (M2-05b security review): the mid-turn instruction reload trusts modification times only
- **Severity:** minor · `src/cli/headless-run.ts` (`instructionFilesMoved`)
- An agent that rewrites a launch file and sets its modification time back (`utimes`) hides the change for the rest of the turn; resume's hash check catches it later. Fix: hash the launch files at the reload check, or accept it as inside the threat model and say so in context §3.

### F14 (M2-07 security review): the hidden-character set WebFetch and tool results share misses some invisible characters
- **Severity:** minor · `src/tools/hidden.ts:2`
- `HIDDEN` marks Unicode tag characters and U+2060–2064/206A–206F only. U+061C, U+00AD, U+034F, U+FE00–FE0F, U+180E, U+3164 and U+115F pass through WebFetch pages and tool results unmarked. WebSearch results turn these into spaces (`web-search-services.ts`); WebFetch and the generic taint-on-hidden-characters check (permissions §8) should treat them the same. Pre-existing.

### F15 (M2-07 round 4): look-alike angle brackets survive the WebSearch cleaner
- **Severity:** minor · `src/tools/web-search-services.ts` (`withoutTags`)
- Fullwidth `＜`/`＞`, small-form `﹤`/`﹥` and `〈`/`〉` are not removed, so `＜system＞` reaches the model as text. Same family as F14: fix both with one shared normalisation (NFKC before cleaning, or add the look-alikes to the removed set) in the same task.

### F17 (M2-09b recheck): CI runs per task rose from 5.0 to 7.3, all of it on deep-tier tasks
- **Severity:** minor · `docs/background/workflow-audit-2026-10-19.md` "Recheck"
- M2-06 took 21 CI runs (13 red, including Bun segfaults and hangs on Windows with real local sockets, found only by a temporary CI job), M2-05b 9, M2-09 9; the other four tasks 3 each. For a task that adds sockets, child processes or timing limits, run its new tests on all three OSes in one temporary CI job (repeated) before the first review round, instead of finding each failure through a review-fix-push cycle. Look at the next recheck's CI-run mean before adding a rule.

### F21 (F19 fix): other tests leave temp directories that `bun run test` does not check yet
- **Severity:** minor · `src/agent/session.test.ts`, `src/cli/headless-boot.test.ts`, `src/cli/resume-target.test.ts`, `src/cli/startup.test.ts`, `src/policy/grants/grants.test.ts`, `src/policy/rules/rules.test.ts`, `src/policy/sandbox/hygiene.test.ts`, `src/policy/sandbox/service.test.ts`, `src/store/secrets/secrets.test.ts`, `src/tools/bash-sandbox.test.ts`
- Running each test file alone with `TMPDIR` set to an empty directory (2026-10-21, Linux) left `dovet-data`, `dovet`, `dovet-ephemeral`, `dovet-ro`, `dovet-trust`, `data`, `dovet-test` (9 from `secrets.test.ts`), `dovet-cwd`, `dovet-rules`, `dovet-hyg`, `dovet-late-symlink`, `dovet-union`, `dovet-m201*` directories. Some may come from the sandbox tests that fail on this machine. Give each a cleanup, then widen `leftovers()` in `scripts/test-run.ts` from `dovet-tool-` to every directory the run leaves.

## Fixed

### F16 (M2-08, M2-09, M2-09c, M2-14 CI): the 500 MB resume test flaked four times
- **Severity:** major (memory on Ubuntu and on macOS twice, the 2 s limit on Windows) · `src/store/event-log/resume.test.ts` (AC-LOG-13)
- **Cause:** the test measured RSS and time inside the process that had just written 500 MB, so garbage from the writes, earlier tests in the file and the runner's disk state decided the number, not the scan.
- **Fixed (PR 182):** the scan runs in a fresh `bun` child (`test/fixtures/resume/scan-child.ts`) that collects garbage, samples its own RSS and reports; the sidecar resume is timed three times and the best counts. Measured on Linux: 34 MB growth against the 300 MiB limit (a whole-file read gives over 500 MB). The limits are unchanged.

### F18 (M2-09c CI): the first headless image test hit the 5 s timeout on macOS
- **Severity:** major (logged twice: #172 and #177, run 39671350287) · `src/cli/headless-image.test.ts:85` (AC-TOOLS-20)
- On `macos-latest` the first two tests of the file took 5.0 s and 4.6 s (the third 0.66 s; Ubuntu 60 ms): "the picture is logged as media…" failed at the 5 s default and Bun reported "killed 1 dangling process".
- **Cause (timed on `macos-latest`, 2026-10-21):** not the decoder (`Bun.Image` 27-44 ms cold) and not the shell parsers (90-160 ms cold). `openCheckpoints` runs real `git` (`git --version`, then the private snapshot store) and on a cold runner that took 1.7 s in one probe and 3.6 s in another before the model request; the image tests have nothing to do with checkpoints.
- **Fixed:** #178 (the file's projects set `checkpoints.enabled: false`; the same probe then spent 0 ms there and the first test took 297 ms cold). Other test files that call `runHeadless` still start real git (`headless-boot`, `headless-run`, `headless-websearch`); none has timed out yet, so they are left alone.

### F20 (M2-09c reviewer eval): resume then a new writer may glue an event onto a torn line
- **Severity:** major (reproduced) · `src/store/event-log/resume.ts:434`
- A `medium` reviewer run on M1-29 reported that after resuming a log whose last line is half-written, the next writer appends its event to that half line, corrupting both. Write a log ending in a partial line, resume, append, and read it back.
- **Fixed (#175):** `resumeSession` wrote the sidecar with `bytes` = the file size including the half line, so the writer's size check passed and skipped the `\n` + crash-repair marker; the sidecar now records only the complete lines. Test `resume.test.ts` "resuming a torn log … never glues", ASCII and a cut multi-byte tail.

### F19 (M2-09 progress entry): test runs leak `dovet-tool-*` temp directories
- **Severity:** major · unknown source (the M2-09 tests clean up)
- 42,000 leftover `dovet-tool-*` directories (31 MB each) filled the 7.6 GB `/tmp` and made `bun run check` fail with EDQUOT in four unrelated tests. Find which test or tool creates them without removing them (count `dovet-tool-*` before and after each test file), fix it, and add a check that a test run leaves none behind.
- **Fixed:** #174 (cause: `test-context.ts` registered its cleanup hook inside the module, which Bun loads once, so only the first test file's workspaces were removed; the hook is now a preload. Two more leaks fixed: Bash's `<cwd>-tmp` in the checkpoint test and a snapshot still writing after the interrupt test. `bun run test` now fails on any left `dovet-tool-*` directory)

### F2 (live test 2026-10-19): `dovet -p` JSON output reports only the last request's usage
- **Severity:** major · `src/cli/headless-run.ts:894` (and `:1044` on resume)
- `usage = jsonSafeUsage(e.usage)` replaces the usage on every model response instead of summing it. Live runs on `nvidia/nemotron-3.5-super-vl-120b-a12b`: job 1 made 10 requests (70 867 prompt tokens in the event log) and reported 8 124; job 2 made 14 requests (123 740) and reported 11 957. `receipt` came back `{}` both times. Check `cost` the same way. This breaks the promise that Dovet can't hide what it cost; the fix needs a test with a multi-request turn that asserts the summed usage.
- **Fixed:** #160 (usage and cost add up every request of the turn; every exit of `runHeadless` reports the cost so far)

### F5 (wiring check 2026-10-20): a project's settings `env` reaches Bash, LD_PRELOAD and PATH included
- **Severity:** blocker · `src/tools/bash.ts:291`, `src/tools/shell-env.ts` (`scopedSettingsEnv`, `startShellSnapshot`)
- AC-CLI-12 requires project `env` to be dropped until the folder is trusted, and `PATH`, `LD_PRELOAD` and `GIT_*` refused even then. `scopedSettingsEnv` does this, but nothing in the product calls it: Bash passes the merged `ctx.settings.env` straight to `commandEnv`. Reproduced: `.dovet/settings.json` with `{"env": {"LD_PRELOAD": "/evil.so"}}` yields merged env `{"LD_PRELOAD":"/evil.so"}`, which every command gets. The AC-CLI-12 test checks the pure function, not the Bash path. `startShellSnapshot` is also unwired, so `shell.snapshot` never takes effect. Class: built and tested, never called. Fix through the product path, with a test that runs Bash with a project settings file.
- **Fixed:** #159 (project and local `env` filtered in `loadSettings`; shell snapshot started in `runHeadless`)

### F1 (workflow PR #145): two instruction-file tests fail on Windows in about half of CI runs
- **Severity:** major · `src/agent/transcript/instruction-files.test.ts:427` and `:461`
- "on resume, a new launch file or an edited import is sent" gets no resume updates, and "an external file imported by an approved external file is asked about too" leaves `@C:\...\b.md` uninlined (AGENTS.md's import of `a.md` is not inlined either). Both fail together, only on `windows-latest`, in 9 of 20 `main` runs since #127 on 2026-10-19 (e.g. run 39249977478); #127 didn't touch these files, so it is an older bug its extra tests exposed. Contents are compared by sha256, not mtime, so suspect the Windows path handling between builds (approval keys, `pathKey` dedupe of the two importers) rather than timing. Reproduce on a Windows runner with `bun test src/agent/transcript/instruction-files.test.ts --rerun-each 20`.
- **Cause:** NTFS file IDs exceed 2^53 once their sequence number reaches 32, so neighbouring files rounded to the same `dev:ino` dedupe key and the second one was skipped. Fixed by bigint stats in the instruction loader and settings reload; 30 consecutive Windows runs of the file passed (1 020 pass, 0 fail).
- **Fixed:** #148

### F9 (M2-05 security review): a gitignored `settings.local.json` in an unpacked archive is trusted as personal
- **Severity:** major · `src/store/config/trust.ts` (`localSettingsRepoSupplied`), permissions §11
- "Not tracked by git" does not mean "the user wrote it". An archive of a real checkout whose author's `settings.local.json` is gitignored, or an archive with a minimal `.git` (just `HEAD`, `objects/`, `refs/`), gives `{project: false, local: true}` and its `allow: ["Bash(*)"]` applies in an unattended `-p` run. Fix: a local file is personal only when its exact text matches a hash Dovet stored in `<data>` when it wrote the file (`saveLocalRule`, M3-05's saves); anything else goes into the trust hash and the dialog. Needs a spec change to §11 (the owner-set rule is "unless tracked by git").
- **Fixed:** #162 (a local file is personal only when its text matches the hash Dovet recorded in `<data>/local-settings.json` when it saved a rule; permissions §11, Q71)

### F12 (M2-05b security review): instruction-file size check and read are separate steps
- **Severity:** minor · `src/agent/transcript/instruction-files.ts` (`admit` size check, `load` `readOrNull`)
- A file grown after the 4 MiB `stat` check is read in full, and a FIFO swapped in between the `isFile()` check and `readFile` hangs the reload. Fix: read through one opened handle (`fstat` then bounded read).

### F13 (M2-05b security review): a failed mid-turn instruction reload is not in the session log
- **Severity:** minor · `src/cli/headless-run.ts` (the `discoverInstructions(...).catch` in the request loop)
- The warning reaches stderr and the output's `warnings`, but no event records that a changed instruction file was not applied. The log still matches what the model was told. Fix: a warning-only `instructions.loaded` event (needs the current records kept next to `launchFiles`).

### F22 (M2-10 CI): the 10,000-file checkpoint speed test ran past its 300 s limit once on Windows
- **Severity:** minor · `src/store/snapshots/checkpoints.test.ts` ("the second snapshot of an unchanged 10,000-file repository is fast", AC-CKPT-05)
- `windows-latest` in the CI run for #176 (run 39663850374) failed it at 301,090 ms against its 300,000 ms limit; the same test passed on the next push of the PR (no change to `snapshot()` between them) and on `main` before. The time is spent creating and snapshotting 10,000 files on the runner's disk, not in the 200/400 ms assertion. Not reproduced (no Windows here); if it happens again, log the time of the rig's file creation and of the first snapshot separately so the slow part is known before a limit is touched.
- Again on `macos-latest` in the CI run for #177 (run 39671350287): the same test failed after 32,826 ms, in a run where the F18 image test also timed out, so a slow runner is likely; the diff of #177 does not touch `snapshot()` or the headless boot.
