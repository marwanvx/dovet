# Progress log

Append-only. One entry per session, newest last ([build loop](../../workflow/build-loop.md) step 9).

## 2026-10-12 — planning complete
Done: v0.1 specs, decisions, prompts and the M0 task list are written. No code exists yet.
Learned: the repository is created by task M0-01; everything before it lives in `docs/`.
Next: M0-01.

## 2026-10-12 — task lists for M1–M5 written
Done: 88 tasks across M0–M5; every acceptance criterion is placed in exactly one task's "Done when"; every task's reading list resolves with `scripts/next.py`.
Learned: each milestone's list is re-checked against what was actually built before its first task starts (build loop step 4).
Next: M0-01.

## 2026-10-12 — M0-01 Repository scaffold
Done: module tree, `bun run check` (type check, Biome, dependency-cruiser boundaries, tests, spec coverage, docs check), CI green on Linux/macOS/Windows, community files; docs scripts ported to `bun run next` / `docs:boxes` / `docs:check` (Python versions removed). PR: #1 (merged).
Learned: `typescript` is pinned to 6.0.3 because dependency-cruiser needs `<7` (Bun's own `bun check` does the type check). This session's GitHub integration gets 403 on Actions re-runs and branch protection: the three CI jobs are not yet required status checks on `main` (owner can add `check (ubuntu-latest)`, `check (macos-latest)`, `check (windows-latest)`). Dependabot uses the `bun` ecosystem as an assumption (QUESTIONS Q1). A `setup-bun` download can 504 on macOS; that's GitHub, not the code.
Next: M0-02.

## 2026-10-12 — M0-02 Compiled binary and safe compile flags
Done: `bun run build` compiles `src/cli/main.ts` (prints the version) into `dist/dovet` with `.env`/`bunfig.toml` autoload off; `compileDovet()` in `scripts/build.ts` holds the compile options; AC-ARCH-01 tested on all 3 OSes. PR: #2 (merged).
Learned: Bun 1.4.2's `bun check` runs the package's `check` script instead of type-checking, so `bun run check` recurses forever: use Bun ≥ 1.4.3 locally (CI pins 1.4.3). `dovet` can't spawn children yet, so the `.env`-in-child half of AC-ARCH-01 uses a probe compiled with the same options (`test/platform/compile-flags/env-probe.ts`). `scripts/build.ts` isn't in architecture "Repository layout" yet (only the `build` script is); add it with the next spec change.
Next: M0-03.

## 2026-10-12 — M0-03 SPIKE-15: tree-sitter grammars inside the binary
Done: `loadShellParsers()` (`src/policy/shell-parse/load.ts`, exported from `policy`) embeds the tree-sitter runtime and the Bash and PowerShell grammars in the compiled binary; a probe built with Dovet's compile options parses 10 Bash and 10 PowerShell commands on all 3 OSes, flags malformed ones, and loads every `.wasm` from the embedded filesystem. SPIKE-15 resolved: yes, no fallback. PR: #3 (merged).
Learned: import the `.wasm` files `with { type: "file" }` (typed by `src/policy/shell-parse/wasm.d.ts`) and pass the runtime's bytes as `wasmBinary`, or the compiled binary looks for `/$bunfs/root/web-tree-sitter.wasm` and fails. Call `loadShellParsers()` once per process (web-tree-sitter keeps one runtime instance); the caller owns the result. All three `.wasm` are ABI 15 (≈2.6 MB). For M1's 200 ms budget: 0.27.1 types `progressCallback` as returning `void` though its docs say `true` cancels. Local Bun must be ≥1.4.3 (`curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3`).
Next: M0-04.

## 2026-10-12 — M0-04 SPIKE-2: install-directory layout with bundled ripgrep
Done: `bun run release` (`scripts/build-release.ts`) builds all 8 `dovet-<version>-<target>.tar.gz` archives (`dovet/dovet(.exe)` + `dovet/libexec/rg(.exe)`, ripgrep 15.1.0 pinned by SHA-256, build fails on a wrong-OS or wrong-CPU binary); `platform.libexecPath` is the one place that knows the layout; on all 3 OSes in CI the unpacked binary finds `libexec/rg` from its own location and runs `rg --version`. SPIKE-2 resolved for the archive and `rg`. PR: #8 (merged).
Learned: `Bun.Archive` writes every entry as mode 0644, so the script writes its own ustar (execute bits kept, reproducible bytes). Archive root is `dovet/` (M0-09's install script extracts it into `versions/<v>/`); archives are `.tar.gz` on Windows too (an assumption: Windows 10 21H2+ ships `tar.exe`). Callers of `libexecPath` must pass the real path of the executable (`realpathSync(process.execPath)`), and tests must compare paths by `realpathSync.native` (macOS `/var` links, Windows `RUNNER~1` short names). ripgrep's licenses aren't in the archive yet: `gen-notices.ts` (M0-09) must add them. ripgrep has no Linux arm64 musl build: that archive ships without `rg` (QUESTIONS Q2). Every CI run downloads the six ripgrep assets; an `actions/cache` step needs a verified pinned SHA. `src/cli/main.ts` doesn't use `libexecPath` yet (Grep, M1). Local Bun must be ≥ 1.4.3.
Next: M0-05 (SPIKE-16, sandbox-runtime under the compiled binary; fills `libexec/srt/`), or M0-06/07/08 (independent).


## 2026-10-12 — M0-05 SPIKE-16: sandbox-runtime under the compiled binary
Done: `@anthropic-ai/sandbox-runtime` 0.0.79 (exact pin) works inside the compiled binary on Linux and macOS with every helper passed by explicit path into `libexec/srt/` (`sandboxRuntimeConfig()`/`startSandbox()` in `src/policy/sandbox/init.ts`; the release build copies the OS's helpers from the npm package into each archive): the proxy is in place, `echo hi` runs sandboxed, a write inside the allowed folder works and one outside is blocked. On Windows `srt-win.exe` is found at the configured path and `initialize` reports the one-time admin install is missing (the backend is not exercised until M2). SPIKE-16 resolved in open questions. PR: #11 (merged).
Learned: without the explicit seccomp path the library still starts and only warns "seccomp not available", so the test requires zero warnings. Linux CI needs `bubblewrap`, `socat` and `kernel.apparmor_restrict_unprivileged_userns=0`. sandbox-runtime brings zod 3.25.76, hoisted to the top level until Dovet adds zod 4: the task that adds zod 4 must check `src/` imports v4. It keeps one `SandboxManager` per process (`startSandbox` once; caller owns it). `sandboxRuntimeConfig` throws if the helpers sit inside a write grant. The unpacked layout is flat (`libexec/srt/apply-seccomp | srt-win.exe | srt-proxy-agent.jar`); I corrected architecture "Distribution" and permissions §7.1 to say so in this PR (a wording fix, no decision changed). For M0-09's `gen-notices.ts`: the archive now ships Apache-2.0 sandbox-runtime binaries, and the compiled binary embeds `node-forge`, `@pondwader/socks5-server`, `commander` and `zod` 3 (licenses and NOTICE files needed). Local Bun must be ≥ 1.4.3.
Next: M0-06 (needs the owner at real terminals), M0-07 or M0-08 (independent); M0-09 needs the owner's release key.

## 2026-10-12 — M0-07 SPIKE-22: git snapshots never touch the user's .git
Done: `src/store/snapshots/` (`openSnapshotter`: `snapshot()` and `restore()`) with tests for AC-CKPT-02, AC-CKPT-03 and AC-CKPT-04 on all 3 OSes; per-phase timings in `SnapshotResult`; `scripts/bench-snapshots.ts` and the `snapshot-bench` workflow (manual only: Actions > snapshot-bench > Run workflow, file count as an input). SPIKE-22 resolved in open questions with timings for all 3 OSes: a repeat snapshot costs about the same as `git status`; two design changes from the measurements (no alternate object directory, Q3; blobs through one `git fast-import` pack, Q4). PR: #13 (merged); spec PRs #14 and #15 (merged first, owner approved in the session).
Learned (for the next session):
- **Windows is slow at creating files, not at git logic.** One loose git object costs about 8 ms on a runner's C: drive, a `git` process about 27 ms. Anything that writes thousands of files (a test fixture's `git add`, a benchmark's setup) needs a long timeout there, a small file count, or a pack. CI temp directories: `os.tmpdir()` is C:, `RUNNER_TEMP` is D: (4 times faster). Test fixtures here use 150 files at most, with a 60 s timeout where needed.
- **Measure the thing, not a neighbor.** The first Windows diagnostic timed `hash-object -w` on objects that already existed. Time each primitive in an empty directory, and print progress lines so a timed-out CI run still shows where it was.
- **Benchmarks in CI:** a measurement is not a gate, so `snapshot-bench` is manual-only (a `pull_request` path filter looks at the whole PR's changed files, not the last commit, so it re-ran on every push, even docs-only ones). It cancels older runs of the same branch. A workflow file that triggers itself costs a run per edit: cancel the runs you don't need (`cancel_workflow_run`), don't leave them.
- Mistakes of mine that cost time, so the next session avoids them: told the owner no reason was recorded for the `typescript` 6.0.3 pin when PROGRESS (M0-01) says it (my search output was truncated: read the whole line); pushed a workflow change whose own path filter re-ran the benchmark; a stop hook that insists on pushing every commit makes each local fix start CI, so batch fixes before the last commit, not after.
- Permissions in this cloud session: a local `git merge origin/main`, a force-push and a command containing `rm -rf *` were each refused by the session's safety checks. Don't work around them: merge main through GitHub's "update branch", create a new branch name instead of force-pushing, and never use `rm -rf *` (use `rm -rf <exact dir>` or leave temp files to the scratchpad).
- TypeScript stays on 6.0.3 on purpose: `dependency-cruiser` (including its latest 18.6.0) supports TypeScript `<7`, and with 7.0.2 its boundary tests fail (it silently stops seeing TS imports). Dependabot PR #12 proposes 7.0.2; the owner will decide (Q5). Replacing the checker (Bun's import scanner omits type-only imports, so it would need its own scanner) is the way to move to 7.
- For M2 (checkpoints): `restore(tree, skipped)` needs the checkpoint's `skipped` list (store it with the checkpoint event); a file left out of a snapshot is never deleted by a restore. `fast-import` writes loose objects when it gets fewer than 100 objects and a pack above that, so `dovet gc` should repack. AC-CKPT-05's 200 ms budget needs an answer for Windows (Q6). The 2 s notice from checkpoints "Limits" can be built from `SnapshotResult.timings.total`.
Next: M0-06 (needs the owner at real terminals), M0-08 (independent); M0-09 needs the owner's release key.


## 2026-10-12 — M0-06 SPIKE-4: vendored pi-tui on real terminals
Done: pi-tui 1.1.0's TypeScript source vendored in `src/tui/vendor/pi-tui/` with its LICENSE (`VENDORED.md` lists Dovet's changes: native addons removed, Windows VT input through `bun:ffi` in `windows-console.ts`), listed in `THIRD_PARTY_NOTICES`; `scripts/tui-demo.ts` (streaming markdown, editor, overlay, a status line with the last key, colors and full-redraw count) compiled per OS by CI and attached to the run; `--self-test` checked by `test/platform/tui-demo` on all 3 OSes. PR: #17 (waiting for owner: the terminal checklist is in the PR; task stays `in-progress`).
Learned:
- The npm package ships only compiled JS and no LICENSE: the TypeScript source comes from the GitHub tag (`earendil-works/pi`, `packages/tui/src`), the LICENSE from the repository root.
- Under Dovet's tsconfig pi-tui has 221 errors (the three checks beyond `strict`), so the vendored copy is its own TypeScript project (a project reference, `bun check -b`), QUESTIONS Q7. Biome already skipped `src/tui/vendor`.
- **`import.meta.main` is false in a compiled Windows executable** (the demo printed nothing there, exit 0). A file compiled as an entry point must run its code unconditionally; `compileTuiDemo` lives in `scripts/build.ts` (`bun scripts/build.ts --tui-demo <out>`).
- `bun check` outside the `check` script runs the package's `check` script (same name; Bun docs "If package.json has a check script"); inside it, `bun check` is the type checker. `bun run check` always ran each step once (CI log), but `bun run typecheck` alone ran the whole pipeline, so the `typecheck` script is gone and `check` calls `bun check -b` directly. `bun --check` is not a replacement: it ignores `-b` and skips the vendored project. Local Bun here was 1.4.2: install 1.4.3 (`curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3`), otherwise `bun check` recurses.
- `actions/upload-artifact` zips and drops the execute bit: upload one file with `archive: false` (a `.tar.gz` on macOS/Linux).
- Not done (SPIKE-4's second half, M3): width changes re-render only the live region; ≤ 8 ms render slices. The owner's results for items G/H and F tell how far upstream is.
Next: M0-08 (independent); M0-09 needs the owner's release key.
Update (same session): the owner ran the Linux demo in GNOME Terminal (screenshot). Two problems: (1) the demo asked for the theme colors before pi-tui took over the terminal, so the replies (`^[]10;rgb:…^[[?61;…c`) were echoed on screen; fixed in the demo (query after `start`). (2) While the emoji line streamed, it was repeated about ten times: GNOME Terminal draws 👍🏽 wider than pi-tui measures, the padded full-width line wrapped, and every inline frame landed one row lower. Fixed in the vendored copy (inline frames drawn with auto-wrap off, `test/platform/tui-demo/inline-autowrap.test.ts`), reproduced and verified with `@xterm/headless` by making the emulator 2 columns narrower than pi-tui believes (not committed; `@xterm/headless` is not a dependency). Colors were detected (dark, #300a24). Kitty keys off in GNOME Terminal (expected: VTE has no Kitty protocol). The owner hasn't run the rest of the checklist yet.
Update 2 (same session): the owner's second run showed the drawn lines painted but the empty rows, edges and window padding still in the terminal's color, so Dovet now also sets the terminal's default colors while it runs (OSC 10/11 after reading them, OSC 110/111 on every way out; spec and AC-TUI-19 updated). The owner closed testing ("merge now, I won't test again"): SPIKE-4 is resolved with the GNOME Terminal results and the untested terminals listed; #17 merged, M0-06 done.


## 2026-10-12 — M0-08 SPIKE-42 first look: Windows sandbox via MXC
Done: `@microsoft/mxc-sdk` 1.0.0 runs `cmd /c echo hi`, enforces a write root ("Access is denied." outside it, and inside it without the root) and denies egress (allowed egress gets 200), under `bun` and from a compiled executable, on Windows 11 25H2 arm64 and Server 2025 x64, with no setup step (as the runners' administrator user). The compiled executable needs the SDK's native files and `koffi.node` beside it (result under SPIKE-42 in open questions; SPIKE-42 stays open for the M2 escape suite). `test/platform/mxc/` (probe + driver) and the `mxc-spike` workflow (Windows only; runs on PRs touching those files, or by hand) stay for M2 to build on. PR: #18.
Learned:
- **The SDK does not load from a compiled executable as-is:** its FFI layer, `koffi` (a Node-API addon), looks for `koffi.node` next to its own JS on disk. It does load once `koffi.node` sits under `process.resourcesPath` (an Electron hook koffi also checks) and `MXC_BIN_DIR`/`MXC_FFI_DIR` point at a copy of the SDK's `bin/<arch>/`. For M2: ship `libexec/mxc/` and set those from `cli/main.ts`, or call `mxc_ffi.dll` through `bun:ffi` and drop `koffi` and `node-pty` (Dovet already does that for pi-tui's Windows console). The M2 planning check (build loop step 4) should add this packaging work to the Windows-sandbox task.
- **Windows edition matters:** Windows 11 gives tier `base-container` with `filesystemDeniedPaths` (needed for credential denies); Server 2025 gives `appcontainer-dacl` without it, and asks for an elevated `wxc-host-prep` for the system-drive root and the NUL device. Treat Server as degraded (§7.6 invariant) unless M2 shows otherwise.
- GitHub's `windows-11-arm` runner (public repos) is Windows 11 Enterprise 25H2 build 26200.9457: the place to run the M2 escape suite. Bun 1.4.3 has a native Windows arm64 build, and setup-bun installs it.
- `bun add --no-save <pkg>` installs a package for one CI job without touching `package.json` or `bun.lock`. Bun ran none of the SDK's dependency install scripts ("Blocked 1 postinstall"), and `run` doesn't need them.
- Installing the SDK inside this cloud session was refused by the session's safety checks (untrusted code); running it on GitHub's runners is the way.
- Owner rule (this session): few code comments, only where the code can't say it (AGENTS.md, dev-workflow, reviewer checklist).
Next: M0-09 (release pipeline); it needs the owner's release key.


## 2026-10-12 — M0-09 Signed release archives: notices, SHA256SUMS, attestations
Done: M0-09 split in three (M0-09 signing, M0-10 `dovet update`, M0-11 install scripts; exit check now M0-12; Q10). Built `scripts/gen-notices.ts` (`THIRD_PARTY_NOTICES` in every archive, from Bun's build metafile plus Bun, sandbox-runtime, ripgrep, pi-tui), `SHA256SUMS` from `build-release.ts`, `scripts/sign-release.ts` (Ed25519; `--new-key`, `--test-key`), `src/cli/release-signature.ts` (`RELEASE_PUBLIC_KEYS`, empty until the owner's key; `verifiedSha256Sums` for M0-10/M0-11), `release.yml` (tag: build > sign in the `release` environment > attest > verify > publish; pull request: same with a throwaway key, unpublished). AC-ARCH-05 and AC-ARCH-03 pass; the PR's test release verified for real in CI (8 archives attested, tampered copy refused). Formats and the `--source-ref` verify command went into architecture "Distribution" (Q11, Q12). PR: #19 (merged on the owner's request; the release key, W1, waits until before the first public release).
Learned:
- `gh attestation verify` prints nothing on stdout unless `--format json`; check the attested `sha256` in its JSON. Attestations from PR runs carry `refs/pull/<n>/merge`, so users must verify with `--source-ref refs/tags/v<version>` (the test passes `GITHUB_REF`).
- `Bun.build({ metafile: true })` returns an object (not a string); input paths are relative to the working directory. `crypto.subtle.generateKey({ name: "Ed25519" })` is typed `CryptoKey`, so it needs `as unknown as CryptoKeyPair`; `verify` wants `Uint8Array<ArrayBuffer>`.
- In a shell, `bun check -b` runs the package's `check` script (as noted before); use `bun run check` and read its type-check line.
- Bun's LICENSE.md is kept per Bun version in `scripts/licenses/`: a Bun upgrade must add the new file or the release build fails (on purpose).
- zod is still not a dependency; `gen-notices.ts` checks `package.json` fields by hand. The task that adds zod 4 should switch it over.
- sandbox-runtime's `apply-seccomp` is linked statically with glibc (its build script); the notice carries sandbox-runtime's own license as upstream ships it.
- The `release` environment's tag rule (`v*`) is what keeps the key away from pull requests that edit `release.yml`; W1 step 1 must keep it.
Next: M0-10 (`dovet update`). W1 (release key) is not needed until the first public release.

## 2026-10-12 — M0-10 `dovet update` and rollback
Done: `src/cli/update.ts` (`update`, `rollback`, `installRootFor`, `hostTargetId`) and `dovet update [--rollback]` in `main.ts`. Latest version comes from the signed `SHA256SUMS`; signature, then archive checksum, then unpack into `versions/<v>/`, then `current` switches (POSIX symlink rename, Windows junction swap) and `previous` records the version left; only the new and previous version stay. AC-ARCH-02 passes against a real local HTTP server, real `tar` archives and a throwaway key; the fresh reviewer's findings are fixed (see Learned). PR: #21 (CI green on all 3 OSes, the Windows junction swap included; merged).
Learned:
- `Bun.Archive.extract` keeps file modes and silently drops symlink entries (1.4.2/1.4.3) and sanitizes `..`; `update` still refuses links and entries outside `dovet/` as a guard. `files()` lists regular files only.
- `src/cli` code can't call `process.*` (not even `process.pid`); temp names use `crypto.randomUUID()`.
- The Windows junction swap (rename `current` to `current.old`, new junction, drop the old) passed on the Windows CI job; and `installedVersion` puts `current.old` back if a swap was interrupted. AC-CLI-07 (swap while an older `dovet.exe` runs) is M0-11.
- Not covered: `main.ts` passing the embedded `RELEASE_PUBLIC_KEYS` (the tests call `update()` with their own keys); the embedded list is empty until W1.
- The cloud container lacks `bwrap`/`socat`, so the 5 `test/platform/sandbox` tests fail here (and on a clean checkout); CI has them. `bun run check` needs Bun 1.4.3 (the container had 1.4.2).
- Q14 records the update decisions (spec text added to architecture "Distribution").
Next: M0-11 (install scripts) once #21 is merged.

## 2026-10-12 — M0-11 Install scripts
Done: `install/install.sh` and `install/install.ps1` verify the Ed25519 signature on `SHA256SUMS`, then the archive checksum, refuse links and paths outside `dovet/`, unpack into `versions/<v>/`, point `current` (symlink / junction), link `~/.local/bin/dovet` or add the user PATH entry (never rc files, never the system PATH), record `previous`, and leave an existing install untouched on any refusal. AC-CLI-07 passes in CI on all three OSes, including `dovet update` swapping the junction while a copy of `bun.exe` runs as the older `dovet.exe`. PR: #22 (merged after green CI).
Learned:
- Q15: POSIX verifies with OpenSSL 3 (macOS's LibreSSL can't; the script also tries Homebrew's `openssl@3` after an RFC 8032 self-test; the macOS runner passes). Windows PowerShell 5.1 has no Ed25519, so `install.ps1` carries its own BigInteger RFC 8032 verifier (about 1.5 s on pwsh 7, seconds on 5.1); the Windows tests run it under `powershell.exe` as `iex (Get-Content -Raw ...)`.
- `Bun.spawnSync` blocks the event loop, so a test that serves releases from the same process must use async `Bun.spawn`.
- `Get-FileHash` is missing in Windows PowerShell 5.1 when the parent is pwsh 7 (its `PSModulePath` leaks in); the script hashes with .NET instead. `[Environment]::GetEnvironmentVariable('Path','User')` expands `%VAR%`; the script reads and writes the registry value unexpanded (`ExpandString`) so the user's PATH keeps its variables.
- On Windows runners the temp dir has 8.3 names (`RUNNER~1`) while .NET prints long names: compare with `realpathSync.native`.
- A local PowerShell 7 can be fetched from the PowerShell GitHub release for parse-checking `.ps1` files in the cloud container.
- The release key is still W1; until `DOVET_EMBEDDED_KEYS` / `$EmbeddedKeys` / `RELEASE_PUBLIC_KEYS` hold it, the scripts refuse to install real releases (a test keeps the three equal: W1 must change all three).
- Not done here: `dovet uninstall` (M3-11), the Git for Windows prompt's "doesn't ask again" memory (first-run wizard, M3), the CI job that installs the real test release built by `release.yml` (the tests install synthetic signed releases on all three OSes instead).
Next: M0-12 (exit check).


## 2026-10-12 — M0-12 Exit check
Done: compared the roadmap's M0 exit evidence with CI on `main` (#22, green on Linux and macOS, Windows running at the time) and the tests. Met on all 3 OSes in CI: tree-sitter parse, bundled `rg`, pi-tui screen (`tui-demo`), `.env`/`bunfig` autoload off, 8 archives, notices, signed `SHA256SUMS`, attestations, update and rollback, install scripts, Actions pinned by SHA, import boundaries, Bun 1.4.3. Not met, so M0 stays open: (1) snapshot take and restore only runs from source, not the compiled binary (new M0-13); (2) install and update are tested against synthetic signed releases, not the archives `release.yml` builds (new M0-14); (3) the sandboxed `echo` on Windows needs the one-time Windows sandbox install and is left to the M2 escape suite (Q16, a known gap). PR: #23 (docs only, merged after `docs:check` and `spec:coverage`).
Learned: Putting an AC ID anywhere in a task's text counts as placing it, so follow-up tasks must not name IDs already placed. W1 (release key) is still the only owner item and is not needed until the first public release.
Next: M0-13 (compiled-binary snapshot), then M0-14.

## 2026-10-12 — M0-13 Snapshot take and restore from the compiled binary
Done: `test/platform/snapshots/` builds a probe with Dovet's compile options, runs it from a temp directory against a repo with local and global clean/process filters and a `core.fsmonitor` command, and checks files restored, created files removed, `.git` byte-identical (mtimes too), no filter or connection, plus a control showing plain git does run those filters on that OS. CI green on Linux, macOS and Windows. The fresh reviewer's findings are fixed. PR: #24 (merged after green CI).
Learned:
- A "filter never ran" test needs a positive control on every OS; a global-config filter must have a name the local config doesn't also set, or local overrides it and the check proves nothing.
- Changing a git config override is only caught if the trap would actually fire: `core.fsmonitor=true` is not a command, so use another key to remove the override when breaking it by hand.
- No new feature code and no new criterion IDs.
Next: M0-14 (CI installs and updates the real test release).

## 2026-10-12 — M0-14 CI installs and updates the real test release
Done: a pull request's `build` job makes a throwaway Ed25519 key, compiles its public half and the loopback update URL into the test binaries only (`define`), signs the release and a next-patch release for the three CI targets, and drops the key. A new `install` job on Linux, macOS and Windows installs the built archive with `install.sh` / `install.ps1`, runs `dovet --version`, then `dovet update` and `--rollback` twice (`test/platform/release-install`). A tag build embeds nothing extra; its `install` job installs with the embedded keys and runs it, and `publish` waits for it. CI green on all three OSes. PR: #26 (merged after green CI).
Learned:
- `compileDovet` always defines `DOVET_TEST_UPDATE` as `undefined`; without that a normal binary still reads the global at run time and a `BUN_OPTIONS` preload could set it. A test checks the normal binary doesn't contain the identifier.
- A job skipped by `if` makes an implicit `success()` skip every job that needs it, so `publish` states `!cancelled()` and the results it needs.
- Local Bun is 1.4.2 (CI pins 1.4.3): building archives locally needs a temporary copy of `scripts/licenses/bun-1.4.3-LICENSE.md` as `bun-1.4.2-LICENSE.md`, and `bun run check` loops (no `bun check` subcommand); run tsc, biome, depcruise and `bun test` by hand.
- `BUN_OPTIONS --preload` runs in a compiled binary (reproduced); Bun has no opt-out, which permissions §0 already records, with its mitigations owned by later tasks.
- W1 (release key) is still the only owner item; the tag path of the `install` job is untested until the first tag.
Next: M0 is complete (14/14); the next session plans M1 (build loop step 4).

## 2026-10-12 — M1 plan re-check
Done: re-checked the 31 M1 tasks against what M0 built (build loop step 4). Every reading list prints real sections; every criterion stays placed once. Four tasks got notes from M0: M1-01 adds zod 4 (sandbox-runtime hoists zod 3; check `src/` imports, switch `gen-notices.ts`), M1-02 builds `Platform.libexec` on `libexecPath` and compares paths with `realpathSync.native`, M1-17 handles the `linux-arm64-musl` archive without `rg` (Q2), M1-22 reuses `loadShellParsers()` and must prove the 200 ms cancel works (`progressCallback` is typed `void`). No task added, split or moved. PR: docs only, merged after `docs:check` and `spec:coverage`.
Learned: no spike M1 needs was answered in M0 except SPIKE-15 and SPIKE-16, which M1 does not list. The fresh-reviewer check of the plan was skipped: the edits are four notes, not structure.
Next: M1-01 (core schemas, runtime and test helpers).

## 2026-10-13 — M1-01 Core schemas, runtime and test helpers
Done: zod 4 and `ai` pinned; schemas for primitives, parts, envelope and a settings skeleton in `src/schema/`; `createRuntime`/`RuntimeDeps` in `src/agent/` (two runtimes share no state, unit-tested); fake clock, id generator and temp-project helpers in `test/helpers/`; Biome GritQL rules in `scripts/lint/` ban top-level `let`/`var` and `process.env`/`chdir` writes in `src/`. The reviewer's findings are fixed. PR: #28 (merged, CI green on Linux, macOS and Windows). The previous session ended before this entry and the `Status:` line; this session closed them after re-running `bun run check` (234 pass, 0 fail) on Bun 1.4.3.
Learned:
- Local Bun is now 1.4.3, the version CI pins, so `bun run check` runs as written (the 1.4.2 workarounds in the M0-14 entry no longer apply). `bun upgrade` fails in the cloud sandbox: `BUN_OPTIONS=--smol` is read as a package name (run it with `env -u BUN_OPTIONS`), and github.com is blocked, so install the npm package `@oven/bun-linux-x64@<version>` and copy its `bin/bun` over `~/.bun/bin/bun` after checking the registry sha1.
- The sandbox tests (`test/platform/sandbox`) need `bubblewrap` and `socat` on Linux, as CI installs; a fresh cloud container lacks them (`apt-get install -y bubblewrap socat`), and without them five tests fail with "Sandbox dependencies not available".
Next: M1-02 (platform layer: dirs, paths, processes).

## 2026-10-13 — M1-02 Platform layer: dirs, paths, processes
Done: `src/platform/` has config/data/cache dirs per OS, path canonicalization with `pathKey`/`isWithin`, executable resolution that skips the project, and process spawn with tree kill; AC-PLAT-02, AC-PLAT-03 and AC-PLAT-05 are tagged and pass, and SPIKE-10 is answered in open questions. PR: #31 (merged, CI green on Linux, macOS and Windows). The previous session ended before this entry and the `Status:` line; this session closed them after re-running `bun run check` on Bun 1.4.3 (283 pass, 0 fail).
Learned:
- Updating Bun in the cloud sandbox: `curl -fsSL https://bun.sh/install | bash -s "bun-v<version>"` works (the registry's `latest` dist-tag of the npm `bun` package names the newest version). `bun upgrade` still fails: the sandbox sets `BUN_OPTIONS=--smol`, which it reads as a package name; run `env -u BUN_OPTIONS bun upgrade` and it then asks for a manual upgrade. This replaces the npm-package copy trick in the M1-01 entry.
- `apt-get install -y bubblewrap socat` needs `apt-get update` first in a fresh container; without them five tests in `test/platform/sandbox` fail.
Next: M1-03 (settings: loading, precedence, migration, Claude Code compatibility).
