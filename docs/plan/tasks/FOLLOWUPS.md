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

### F67 (F59 round-3 review): `!VAR!` is not an unresolved destination without a cmd layer
- **Severity:** minor · `src/policy/decide/targets.ts:102` (`unresolvedTarget`)
- `git push origin +!BRANCH!` allows in `bypassPermissions`: `!` is in no unresolved class, while the `cmd /c` spelling asks since F59 (delayed expansion is in its metacharacter set). In a shell where `!` expands (zsh/fish history, cmd with `/v:on` without the layer) the destination is known only at run time. Add `!` to `unresolvedTarget` like F64's `%`, or name the limit where the class is claimed.

### F68 (F59 round-3 review): cmd-operand `,` and `=` are not metacharacters
- **Severity:** minor · `src/policy/decide/critical.ts:37` (`CMD_META`)
- `cmd /c git,push,origin,+main` and `cmd /c rd,/s,C:\Windows` allow in `bypassPermissions`: `,` and `=` are not in `CMD_META`. cmd's own delimiter handling of them was not verifiable without cmd.exe (for external commands the child CRT re-splits on spaces, so the spellings may be benign; internal commands are the plausible risk). Decide with a real cmd: either add them to the class or record them as read-as-typed.

### F69 (F52 security review): a file a command outside §4.6's forms reads gets no sensitive or outside check
- **Severity:** minor (pre-existing) · `src/policy/shell-parse/bash.ts` `command()` (operands only from `classify`), permissions §4.0 item 4, §4.7
- Under a tool-wide `Bash` allow `grep -e x .env`, `tail -f .env`, `jq . .env`, `sed -n p .env`, `base64 .env`, `git show HEAD:.env` run unprompted while `cat .env` asks: a literal file is read-checked only when the whole call is a read-only form. Decide whether §4.7 covers these (read every non-option word of a known reader as a read operand) or write the limit into §4.7.

### F70 (F52 round-2 security review): an option's write target isn't an edit target
- **Severity:** minor (pre-existing) · `src/policy/decide/targets.ts` `shellTargets`
- Under a tool-wide `Bash` allow `sort -o ../out a.ts` writes outside the working directories unprompted while `cp a.ts ../out` and `echo x > ../out` ask. Add `sort -o`/`--output` and the other `-o FILE` writers as edit targets.
### F58 (F34 round-2 tests review): a SIGINT during compaction degrades stream-json like the budget stop did
- **Severity:** minor (pre-existing, M2-14) · `src/cli/headless-run.ts:1318-1332` (`stoppedDuringCompaction`)
- The interrupted-during-compaction output returns without `events` (`--output stream-json` gets the text fallback, `src/cli/main.ts:301-305`); F34 round 1 fixed the same class for the compaction budget stop. One `events,` field, with a test that pins it.

### F61 (F54 security review): many stand-ins decide in quadratic time
- **Severity:** minor (pre-existing) · `src/policy/decide/remote.ts:78-87`
- 2,000 stand-ins in a 4 KB command decide in ~1.7 s (`bypassPermissions`), ~8–9 s near the parse cap: `REMOTE_WORDS` × positions (the force fill adds ~20%). Cap substitution attempts like `MAX_WORDS`.

### F62 (F54 tests review): the bypass corpus wasn't extended with the series' bypasses
- **Severity:** minor (pre-existing) · `src/policy/testdata/bypass-corpus.jsonl`
- testing.md "Permission corpora" says it grows with each Dovet bug; no F32/F42/F54 case is in it. Add them as corpus cases.

### F64 (F54 round-3 review): cmd's `%VAR%` destination spelling isn't an unresolved dst
- **Severity:** minor (pre-existing) · `src/policy/decide/targets.ts:102` (`unresolvedTarget`)
- `git push --force origin %BRANCH%` allows in `bypassPermissions` though the spelling could expand at run time; `%` is in no unresolved class. Add `%` to `unresolvedTarget` (its write-target callers get it in the same stroke) or name the limit wherever the class is claimed. (2026-10-25, F59: the `cmd /c` spelling now asks — a `%VAR%` in a cmd operand is one of the metacharacters that make the layer not fully checkable; the spelling without a cmd layer remains.)

### F65 (F54 round-3 review): a delete of the default branch isn't in §5's deny list
- **Severity:** minor (pre-existing) · `src/policy/decide/remote.ts:170-176`, permissions §5
- `git push origin :main` deletes the remote default branch in `bypassPermissions` while the forced spelling denies. Treat a dst-less delete refspec of a default branch like a force-push of it (§5 and Q42 wording to match).


### F66 (F57 round-3 review): every `find -exec cmd {}` is treated as a deletion
- **Severity:** minor (pre-existing, F32) · `src/policy/decide/targets.ts:215-222` (`findDeletions`'s `-exec` arm)
- `find .config -exec echo {} \;` asks (unnamed reach) though `echo` deletes nothing: any `-exec` with a `{}` counts. Restrict the arm to removal-capable commands or lift the reach ask for proven-non-writing commands, and align Q90's sentence.

### F53 (F32): an `xargs -I{}` replace string inside a `sh -c` script isn't the xargs input
- **Severity:** minor · `src/policy/decide/targets.ts` `xargsRuns`
- `echo / | xargs -I{} sh -c 'rm -rf {}'` in `bypassPermissions` runs with no countdown: the script's `rm -rf {}` is parsed as its own command, without the stand-in. Under other modes the `{}` write target still asks.

### F50 (F40 review): wrappers outside §3.2's list hide the command
- **Severity:** major · `src/policy/rules/shell.ts` `DEEP_WRAPPERS`, `decide.ts` `PEELED`
- `chroot`, `taskset`, `nsenter`, `unshare`, `runuser`, `strace`, `su -c`, `script -c`, `pkexec`, `fakeroot`, `systemd-run`, `chrt`, `numactl`, `parallel`, `exec -a x`, `busybox`, `cmd /crd`: one `DEEP_WRAPPERS` entry each; changes §3.2.
- Extended (F32 round-3 security review): the same wrappers take a command named by xargs input — `echo root -c 'rm -rf /' | xargs su` — allowed in `bypassPermissions`; Q91's `commandFromInput` returns false for a name outside its set.

### F51 (F40 review): an unparseable command is allowed in tainted bypass
- **Severity:** major (pre-existing) · `src/policy/shell-parse/analyze.ts`, `decide.ts`
- Over 10,000 characters or the 200 ms budget, a command is unparseable and skips §4.8 (`env` + `-S x` ×10000 + `git push`).
- Extended (F63 security review): an unparsed analysis (`commands` undefined) makes `shellFindings` produce no findings, so **untainted** `bypassPermissions` allows too — every built-in check skipped (§5, countdown included); under CPU contention the 200 ms budget actually misses (`guarantees.test.ts:794` received `allow` on `main` under 6 CPU hogs). Fix: ask in bypass (deny in `dontAsk`) when `!analysis.understood`/`commands === undefined` before the early return, or push an `unchecked` ask in `shellFindings` (not in `BYPASS_SKIPS`).

### F41 (M2-16 security review): `git -c alias.p=push p` hides a push from the remote-action check
- **Severity:** major · `src/policy/decide/remote.ts:22-30`
- `test.failing`: allowed in tainted bypass. Same gap (minor): `git send-pack`, `gh release upload`, `wget --method=POST`, `npx npm publish`.

### F42 (M2-16 security review): `~user`, `~+`, `$PWD` aren't critical spellings
- **Severity:** major · `src/policy/decide/critical.ts:61-72`
- `test.failing`: in `bypassPermissions` `rm -rf ~+` and `rm -rf "$PWD"` run with no countdown. Extended (F32 security review): the same class when a remover's target or recursion flag comes from xargs input — `echo '-rf /' | xargs rm`, `echo C:\Windows | xargs cmd /c rd /s`. Extended (F32 rethink round): with the applet typed, `echo rm -rf / | xargs toybox rm` runs `toybox rm rm -rf /` in `bypassPermissions`.

### F55 (F32 security review): `pwsh -c` scripts reach no check, with or without xargs
- **Severity:** minor (pre-existing) · `src/policy/decide/critical.ts` (`criticalRemoval`/`systemRemoval` read `argv[0]` only), no pwsh script analysis exists
- `pwsh -c remove-item -recurse C:\Windows` is allowed even in `default` with a tool-wide `Bash` allow (Q91's unwrapping peels `cmd /c` only); `echo C:\ | xargs pwsh -c remove-item -recurse` inherits it. Read what `pwsh -c` runs like a script, or treat a remover inside it as typed.

### F56 (F32 round-2 tests review): no test pins the section labels of the other finding kinds
- **Severity:** minor (pre-existing) · `src/policy/decide/decide.ts` `SECTION`, `test/adversarial/guarantees.test.ts`
- Every `by` string a prompt shows ("critical-path removal (§4.4)", "remote-action check (§4.8)", …) is asserted nowhere (the F32 round pinned only the new `computed` one), so a wrong section reference reaches users silently — the traps table's "pin the literal text". One `expect(...by)` per kind where a test already produces that finding.

### F43 (M2-16 security review): `.env` values are redacted only when the variable name looks secret
- **Severity:** major · `src/policy/redaction/secrets.ts:60`, `headless-run.ts:446` (project root only)
- `DB_PASS=…`, `STRIPE_SK=…` stay visible to `grep -r . .`; §4.7 puts all `.env*` values in the set. Apply the name filter to the process environment only.

### F44 (M2-16 security review): an invisible character inside a secret stops its redaction
- **Severity:** minor · `src/agent/loop.ts:370-372` (`stripHidden` runs before `redactText`), `src/policy/redaction/redact.ts:29` (folds only U+200B/C/D, U+FEFF)
- `abcd1234\u2060efgh5678` for `MY_API_KEY=abcd1234efgh5678` reaches the model as two clear halves around the removal marker; same for U+00AD, U+034F, U+180E and tag characters. Redact before stripping, and share one character set with F14.

### F45 (M2-16 security review): the "sandboxed command reached an untrusted host" taint misreads hosts
- **Severity:** minor · `src/policy/sandbox/network.ts:149`
- `curl https://registry.npmjs.org@evil.example/x` (user-info read as host), `curl HTTPS://evil.example/x` (case-sensitive scheme), `curl evil.example/x` and `wget -qO- evil.example` (no scheme) return no taint source. In bypass the proxy allows every host, so taint is the only brake.

### F46 (M2-16 security review): the native-PDF branch of Read skips the output guard
- **Severity:** minor · `src/tools/read-pdf.ts:78-98`, `src/agent/loop.ts:369`
- A PDF whose text holds a token, read with `media.pdfs: true`, reaches the stored `document` part unredacted and without a taint effect; the text branch is redacted.

### F47 (M2-16 security review): some read-only shell commands read sensitive files without the §4.7 ask
- **Severity:** minor · `src/policy/shell-parse/read-only.ts:389` (`git show`), `:47`, `:551` (recursive `grep`/`rg`)
- `git show HEAD:.env`, `git log -p`, `grep -r KEY .` and `rg --no-ignore --hidden KEY` are allowed in default mode; `cat .env` asks. `<rev>:<path>` operands and recursion into folders holding sensitive files aren't checked.

### F48 (M2-16 security review): shell writes to protected paths by `tar`, `unzip`, `rsync`, `patch` and `perl -pi` aren't recognised
- **Severity:** minor · `src/policy/decide/targets.ts:6-40`
- With a tool-wide `Bash` allow: `tar -xf x.tar -C .git/hooks`, `unzip x.zip -d .git`, `rsync a.ts .git/hooks/pre-commit`, `patch .git/config p.diff`, `perl -pi -e s/a/b/ .git/config` are allowed; `cp`, `sed -i`, `dd of=`, `tee` and redirects ask. Bash has no equivalent of the PowerShell archive-extraction rule.

### F36 (M2-16 spec review): a last log line without its final newline gets the next event glued on
- **Severity:** major · `src/store/event-log/reader.ts:128`, `writer.ts:127`
- Strip the final `\n` of a closed log, reopen, append: next read is read-only, 0 events. Reader must flag "no trailing newline"; the writer then adds `\n`.

### F37 (M2-16 spec review): blob-mode restore writes through a parent directory turned symlink
- **Severity:** major · `src/store/snapshots/checkpoints.ts:255-284`
- Replace `w/sub` by a link to `../outside` after recording `w/sub/a.txt`: `restore` overwrites `outside/a.txt`. Only the leaf is `lstat`ed; run the git path's `pathBlock` on every component for writes and deletes.

### F38 (M2-16 spec review): a workspace opened through a symlink makes every Dovet write a "conflict"
- **Severity:** major · `src/store/snapshots/checkpoints.ts:179,187`
- Candidates join onto git's real root while `file.change` has workspace paths, so the lookup never matches (macOS `/tmp`, Windows `subst`). Canonicalise both sides.

### F39 (M2-16 spec review): the compaction facts' command output tail can start with a lone surrogate
- **Severity:** minor (pre-existing) · `src/agent/compaction/facts.ts:68`
- `r.output.trim().slice(-600)` on 400 emoji followed by `b` starts with U+DE00 (`isWellFormed()` false) and goes into the request sent to the provider. Use `tailOf(output, 600)` like the other cuts.

### F49 (M2-16 CI): a headless test hit the 5 s default on macOS again
- **Severity:** minor (same class as the fixed F18, F24) · `src/cli/headless-run.test.ts` "a tool-using turn writes the expected event types and fingerprint hash" (5004 ms, run 39779648078, macOS only; passed on the rerun)
- Find what ran in the seconds before it (a parallel file, the ripgrep download test) instead of raising the limit; if it comes back, apply F24's 30 s default to macOS too.

### F30 (M2-16 kill -9 probe): a model response over 1 MB of strings that are each under 256 KB throws and ends the run
- **Severity:** minor (pre-existing) · `src/store/event-log/writer.ts:202`
- 40 parallel `Write` calls of 150 KB each make one `model.response` event of 6 MB; none is moved to a blob (each is under 256 KB), so `append` throws "over 1 MB after moving large strings to blobs". Move the largest strings to blobs until the line fits instead of throwing.

### F31 (M2-16 kill -9 probe): a file change made in the last two seconds before `kill -9` has no event in the log
- **Severity:** minor (design choice in event-log "Writer rules" 3) · `src/store/event-log/writer.ts` (`FLUSH_NOW`)
- The probe (`test/adversarial/kill9.test.ts`) kills a session that writes a file per request: at 1.8 s the files are on disk and the log holds only `user.message`, because `tool.call`/`file.change` wait for the next 2 s flush. After resume nothing says those files changed (and `/rewind` can't undo them). "The agent can't hide what it did": flush `tool.call` of a mutating tool before it runs (no fsync needed).

### F33 (M2-16 adversarial fixtures): two credential and startup files are missing from the §4.3/§4.7 lists
- **Severity:** minor · `src/policy/decide/paths.ts` (protected files, home credential list), permissions §4.3, §7.2
- With a blanket `Read`/`Edit` allow rule, `~/.config/gh/hosts.yml` (the GitHub CLI token) is read and `~/.config/fish/config.fish` (fish's startup file) is written without a prompt; both are outside the working directory only, so only the "outside" ask protects them and a user allow rule lifts it. Add them (and `~/.config/gh` to the §7.2 sandbox deny list) in the spec and the data files.

### F28 (F24): a windows-latest runner stalled for about 20 s in the middle of a test file
- **Severity:** minor · `.github/workflows/ci.yml` (windows job), seen once in CI run 39714803004 attempt 1
- Details in F24's cause. If a Windows test exceeds the new 30 s default (look for "timed out after 30000ms"), find what ran just before it (leftover processes, Defender scanning the temp tree, a disk wait) instead of raising the limit again.

### F27 (M2-15 security review): `permissions.sensitiveFiles` never reaches the policy
- **Severity:** minor (pre-existing) · `src/cli/headless-run.ts` (`policyEnv` has no `sensitiveFiles`); nothing in `src/` sets `Env.sensitiveFiles`, which only ripgrep's globs use (`src/tools/sensitive-files.ts`, `src/tools/rg.ts`)
- A user who adds `**/*.secret` to `permissions.sensitiveFiles` still gets Read of such a file allowed without the sensitive-file ask, and a plan file matching it is still re-attached. Pass the setting into every `Env` the policy gets.

### F25 (M2-15): headless `ExitPlanMode` is denied, so a headless plan is never presented
- **Severity:** minor · `src/cli/headless-run.ts` (`decideFn`), `src/tools/plan-mode.ts:99`
- A scripted model that writes its plan and calls `ExitPlanMode` in `--permission-mode plan` gets `Permission denied: needs the user's answer` (interaction actions ask, headless denies). Tools §11.3 says headless returns the plan as the turn's result with a `plan` event, mode staying `plan`. Allow the call when the mode is `plan`, log `plan.presented`, and make the result the turn's text; the `plan` stream event waits for `--output stream-json`. `ExitPlanMode` is the only tool that reads `ctx.session.mode`, so the rebuild of the tool context after EnterPlanMode (`applyResultMode`) has no observable effect until then: add a test that ExitPlanMode called after EnterPlanMode in the same round is not told "Not in plan mode".

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

### F52 (F32): a `$( )` in a read command's file position reaches no check
- **Severity:** major · `src/policy/shell-parse/bash.ts`, `decide.ts` `shellFindings`
- With a tool-wide `Bash` allow `cat $(echo .env)` is allowed (`cat $X` asks). A substitution's words, like xargs input (Q90), can name any file; treat one in a non-read-only command's arguments like a variable.
- **Fixed:** #195

### F63 (F54 round 3): an abbreviated git long option escapes the forced regex
- **Severity:** major (pre-existing) · `src/policy/decide/remote.ts:169`
- `git push --mir` allows in `bypassPermissions`; real git reads it as `--mirror` and force-updates `main`. Match the abbreviations; `/^--post-/` has the same gap.
- **Fixed (#193):** the force-push check matches `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `--all` and git's `--branches` alias, and the `wget` upload check `--post-data`/`--post-file`, through any unique prefix past the bare `--`, with an optional `=value` (`isLongOption`, shared with §3.2's `needsExactRule`, whose `--force`/`--no-verify`/`--amend` set reads its abbreviations too — Q95). git.c's global options (`--git-dir`) and curl's long options are matched exactly — verified against git 2.53.0, GNU wget and curl: an unknown spelling errors and allows. F51's entry extended from the round's security review.

### F59 (F54 security review): a `cmd /c` layer below the head hides a push from §5 and §4.8
- **Severity:** major (pre-existing) · `src/policy/decide/decide.ts:336`
- `sudo cmd /c git push origin +main` allows in `bypassPermissions` (typed `cmd /c …` denies): check the `cmd`-peeled reading too.
- **Fixed (#192):** each `cmd` reading peels into its operand reading, which re-enters the reader (Q94) — the remote, force-push and find deletion checks run on it and on what expands below it; one `/c` operand word is re-split as the line cmd received while the calling shell's words keep their spaces; a metacharacter (`^"&|;()<>%@!`), an empty word, a quoted first word or a shell script under the layer is not fully checkable and asks (`bypassPermissions` included). F67 and F68 logged from round 3.


### F57 (F32 round-4 security review): a narrowed find reach deletes a sensitive file without the §4.7 ask
- **Severity:** major (pre-existing) · `src/policy/decide/decide.ts:299-305` (the write checks see the start paths; the reach feeds only `criticalRemoval`)
- With a tool-wide `Bash` allow, `rm .env` asks but `find . -name '.env' -delete` runs: the reach crosses only the critical-path check. Run the sensitive/protected checks over the reach's deletions too; §4.4's sentence grows with it.
- **Fixed (#191):** the narrowing tests before each deletion action are matched against the sensitive and protected names (Q93); a test that names no file leaves the reach asking outside `bypassPermissions`, lifted by an exact allow rule; a start path that is a proper prefix of a protected directory's path asks; `-lname` names no file.


### F54 (F32): a `+refspec` from xargs input force-pushes the default branch in untainted bypass
- **Severity:** major (pre-existing) · `src/policy/decide/decide.ts` (the `forcePushToDefault` map), permissions §5
- `echo +main | xargs git push origin` is allowed in `bypassPermissions` while `git push origin +main` denies: the stand-in filling reaches the §4.8 remote check but not §5's `forcePushToDefault`, which reads literal words. Run the force-push check over the stand-in-filled readings too.
- **Fixed:** #190

### F34 (M2-16 spec review): compaction requests never reach the daily ledger
- **Severity:** major · `src/cli/headless-run.ts:1141-1162` (`sendSummary`)
- It calls `meter.record` but no `ledger.reserve/commit`, so the hard daily cap (AC-RCPT-10) undercounts. Reserve and commit like the main request (:1374-1639); also run `meter.check` before `compact()` (F35, minor, :1165). Test: a summary that crosses the day limit is refused.
- **Fixed (#189):** every summary request gates like a main request (meter.check, daily-ledger reserve, commit of the actual spend, release on failure/abort); the first send's reservation is taken by a pre-flight in `compactEpoch` before `compact()`. Six tests in `src/cli/headless-budget.test.ts` pin refusal before send, the reserve/commit lines, per-attempt releases, and a later send's budget stop (a refusal there degraded the compaction to a mechanical fallback — fixed in the same PR).

### F35 (M2-16 spec review): compaction requests get no pre-flight budget check
- **Severity:** minor (pre-existing) · `src/cli/headless-run.ts:1165` (`compactEpoch`, called from :1288 and :1815; `meter.check` runs only at :1367)
- A session at 99% of `--budget` still sends and pays a full summary request before the next check refuses. Estimate the summary request and run `meter.check` plus the ledger reserve before `compact()`; on refusal stop with the budget message. Fix together with F34.
- **Fixed (#189):** `compactEpoch` gates before `compact()` on the summary fork's estimate (last response's usage + transcript growth + the compact prompt); a refusal stops the turn with the budget message and no `compaction` event, auto and context-exceeded both.

### F32 (M2-16, F40 review): `xargs` stdin arguments and `find -delete` reach no check
- **Severity:** major (logged twice) · `src/policy/decide/critical.ts`, `decide.ts`
- Allowed: `echo / | xargs rm -rf`, `find / -delete`, `echo .env | xargs cat` (tool-wide allow); `echo push | xargs git` (tainted bypass). Treat them as unresolvable targets (§4.4).
- **Fixed (#188):** a command xargs runs is checked with a stand-in for its input (critical, write, remote and a new `computed` ask); `find -delete`/`-exec rm {}` removes its start paths, or what's under them with a name test, through the critical-path and write checks (QUESTIONS Q90, Q91).

### F29 (M2-16 kill -9 probe): a string over 256 KB in an event crashes the headless run
- **Severity:** major · `src/cli/headless-run.ts:583`, `src/agent/transcript/build.ts:133`
- `writer.append` returns the blobbed envelope and the run keeps it, so a 300 KB prompt or Write content throws `ZodError … expected string, received object`. Return inflated data; test a 300 KB message, tool input and output (`runIn` in `test/adversarial/harness.ts`).
- **Fixed (PR 187):** `append` returns the scrubbed data with large strings inline (what a reader gets); the line on disk keeps the blob references. `test/adversarial/large-strings.test.ts` runs a 300 KB prompt, Write content and model text through a headless run and resumes it.

### F40 (M2-16 security review): a wrapper written as a path hides the inner command from every check
- **Severity:** blocker · `src/policy/rules/shell.ts:179,188-191,122`, `decide.ts:193-204`, `targets.ts:39`
- `test.failing` in `test/adversarial/guarantees.test.ts`: with tool-wide `Bash` allow `/usr/bin/env rm -rf /` and `/usr/bin/env cat .env` are allowed (`env …` asks); deny `Bash(rm *)` misses `/bin/rm`; tainted bypass allows `/usr/bin/env git push`, `sudo -iu me git push`, `env -S '…'`, `find -exec git push`. Reduce wrappers to the basename and parse their flags once, for all checks.
- **Fixed (PR 186):** the deny side reads each wrapper option both as taking the next word and as not, so a missing or wrong option table entry can't hide the command; allow rules keep an exact GNU grammar of the safe wrappers and see nothing inside on an unknown option; a wrapper with more readings than a 2M-word budget, or an `env -S` string that can't be split exactly, asks in every mode (QUESTIONS Q89).

### F24 (F16 CI): two more Windows tests timed out on a slow runner
- **Severity:** major (second sighting, M2-15 CI run 39714803004: `headless-budget.test.ts` ×3 at 5,001 ms and `snapshots.test.ts` "a blob that is gone…" / "plan lists the paths…" at 5,004–5,218 ms with `git fast-import` failing and EBUSY on cleanup; all passed on a rerun of the same commit) · `test/platform/...` "Bash on every OS > Git Bash: 2>nul creates no nul file; Python prints non-ASCII" (5,002 ms, "killed 1 dangling process", then EBUSY removing its temp dir) and `src/checkpoints` "snapshot > works from a linked worktree, where .git is a file" (5,848 ms, `git init --bare` exited 143)
- `windows-latest`, CI run 39698593461 for #182 (a test-only change that touches neither). Both spawn real processes (Python, git) and hit Bun's 5 s default on a cold runner, the same class as F18. If either repeats, give it a longer limit with the measured time or remove the real process from it.
- **Cause (CI run 39714803004, attempt 1):** a stall of the runner, not slowness of the code. In `headless-budget.test.ts` four tests in a row ran 5 s or more (5,001, 5,001, 5,002 and 4,739 ms, about 20 s in all, the first with zero requests sent), then "two headless sessions racing" ran two full `runHeadless` calls in 137 ms in the same file; the two snapshot tests stalled the same way later (`git fast-import` killed). `checkpoints` was off and `fakePlatform` spawns nothing in the budget tests, and the ledger lock waits only 5-25 ms per try. What stalled the machine is unknown (a quiet runner needs about 1 s per `runHeadless` on Windows, 0.12 s on Linux).
- **Fixed (PR 184):** `test/helpers/timeout.ts`, a second `bunfig.toml` preload, sets the default test timeout to 30 s on Windows only (5 s elsewhere); tests with their own limit keep it. This tolerates a stall like the one seen; it does not explain it, so F28 watches for a longer one.
- **Fixed again (PR 187):** that preload never worked past a run's first file (Bun 1.4.3 applies a preload's `setDefaultTimeout` to the first file only; PR 187's Windows CI timed out at 5 s in `snapshots.test.ts`). `scripts/test-run.ts` now passes `--timeout 30000` on Windows; a file's own default still wins.

### F26 (M2-15): the policy's plan-file shortcut skips every path check, so each place that picks a plan file has to re-validate
- **Severity:** major · `src/policy/decide/decide.ts:123` and `:409-414`, `src/store/event-log/plan.ts` (`projectPlanDir`, `planFileAllowed`), `src/cli/headless-run.ts` (plan re-attach read, Dovet facts read)
- `t.path === env.planFile` returns before the protected-path, sensitive-file, outside-project and link checks, so M2-15 confines the plan file where it is chosen (`plan.directory`, a logged path on resume, a fork's copy). Three review rounds each found another way past that: `..` and `.git`, then `.dovet`/`.env` inside the project, then a link with a plan file's name pointing at a key (a link is now refused, with a test). The same class is still open: the session-plan-folder branch checks the path lexically only; the plan text is read for the re-attach and the facts with no sensitive-file check; Windows short names and alternate streams were read but not run.
- **Fixed (PR 183):** the policy's plan-file exception now skips only the plan-mode default and the working-directory check; protected, sensitive and deny-rule checks run on the plan file, the session's plan folder is in `ownFiles`, and the plan text for a re-attach or the compaction facts is read only where Read is allowed (`readPlanText`). Tests: `decide.test.ts` "the plan file skips only…", `headless-plan.test.ts` "a plan file a Read rule denies…". `planFileAllowed` stays as the location rule for a logged path (a link check is still needed there: the fork's `copyFile` follows links).

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
