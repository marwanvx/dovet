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

### F2 (live test 2026-10-19): `dovet -p` JSON output reports only the last request's usage
- **Severity:** major · `src/cli/headless-run.ts:894` (and `:1044` on resume)
- `usage = jsonSafeUsage(e.usage)` replaces the usage on every model response instead of summing it. Live runs on `nvidia/nemotron-3.5-super-vl-120b-a12b`: job 1 made 10 requests (70 867 prompt tokens in the event log) and reported 8 124; job 2 made 14 requests (123 740) and reported 11 957. `receipt` came back `{}` both times. Check `cost` the same way. This breaks the promise that Dovet can't hide what it cost; the fix needs a test with a multi-request turn that asserts the summed usage.

### F3 (live test 2026-10-19): a fresh install refuses to run without a configured model
- **Severity:** minor · `src/cli/headless-run.ts:149`
- With an NVIDIA key and no settings file, `dovet -p "…"` exits 2 with "no model configured; set model in settings or --model". Pick a default NVIDIA model (the registry's) or name a working `--model` value in the message.

### F4 (live test 2026-10-19): the model retries Bash after the sandbox refused it
- **Severity:** minor · Bash tool result when the sandbox is unavailable
- On a machine where the sandbox can't start (Ubuntu AppArmor user namespaces), job 1 tried `bun test` 7 times, including with `dangerouslyDisableSandbox`, and every try errored. The result text should say plainly that this command can't run in this session, so the model stops.

## Fixed

### F1 (workflow PR #145): two instruction-file tests fail on Windows in about half of CI runs
- **Severity:** major · `src/agent/transcript/instruction-files.test.ts:427` and `:461`
- "on resume, a new launch file or an edited import is sent" gets no resume updates, and "an external file imported by an approved external file is asked about too" leaves `@C:\...\b.md` uninlined (AGENTS.md's import of `a.md` is not inlined either). Both fail together, only on `windows-latest`, in 9 of 20 `main` runs since #127 on 2026-10-19 (e.g. run 39249977478); #127 didn't touch these files, so it is an older bug its extra tests exposed. Contents are compared by sha256, not mtime, so suspect the Windows path handling between builds (approval keys, `pathKey` dedupe of the two importers) rather than timing. Reproduce on a Windows runner with `bun test src/agent/transcript/instruction-files.test.ts --rerun-each 20`.
- **Cause:** NTFS file IDs exceed 2^53 once their sequence number reaches 32, so neighbouring files rounded to the same `dev:ino` dedupe key and the second one was skipped. Fixed by bigint stats in the instruction loader and settings reload; 30 consecutive Windows runs of the file passed (1 020 pass, 0 fail).
- **Fixed:** #148
