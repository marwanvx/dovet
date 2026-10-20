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

## Fixed

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
