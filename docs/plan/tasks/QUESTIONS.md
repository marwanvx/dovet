# Questions for the owner

When a spec doesn't decide something, the agent answers it itself and records question and answer here, under "Answered" ([build loop](../../workflow/build-loop.md) step 6). The owner never has to answer. To change an answer, add a line `- **Override (owner, <date>):** <what you want instead>` to that entry; the next session applies it and adds an `**Override applied:**` line. "Waiting for the owner" is only for things no agent can do (an account, money, a secret, a physical device).

## Waiting for the owner

(none)

## Answered

### Q1 (M0-01): Dependabot ecosystem for the package updates
- **What's missing:** architecture "Repository layout" says dependabot updates "npm (grouped, weekly)". Dovet keeps its dependencies in Bun's lockfile (`bun.lock`), which Dependabot's `npm` setting doesn't update, so its PRs would fail CI.
- **Recommended answer:** use Dependabot's `bun` setting (same weekly, grouped updates). The spec line then reads "Bun packages (grouped, weekly)".
- **Meanwhile:** built that way, marked `ASSUMPTION` in `.github/dependabot.yml`. If you agree, just write "yes".
- **Answer (owner, 2026-10-12, PR #4):** yes, use Dependabot's `bun` setting. Applied: architecture "Repository layout" now says "Bun packages (grouped, weekly)"; the `ASSUMPTION` marker in `.github/dependabot.yml` is removed.

### Q2 (M0-04): ripgrep for Linux arm64 on musl (Alpine)
- **What's missing:** the architecture spec lists eight targets, each with its own `libexec/rg`. ripgrep's official releases have no Linux arm64 musl build (only arm64 glibc), and the glibc one won't run on Alpine. The other seven targets are covered.
- **Recommended answer:** for v0.1, ship the `linux-arm64-musl` archive without `libexec/rg`. The spec already says Dovet falls back to an `rg` on PATH and says so (tools "Grep"; not built yet); `dovet doctor` and the install script tell Alpine arm64 users to run `apk add ripgrep`. Building ripgrep ourselves in CI (Rust, cross-compiled) can come later if people need it.
- **Meanwhile:** built that way, marked `ASSUMPTION` in `scripts/build-release.ts`. If you agree, just write "yes".
- **Answer (owner, 2026-10-12):** use the recommended answer. Applied: architecture "Distribution" now says the `linux-arm64-musl` archive has no bundled `rg`; the `ASSUMPTION` marker in `scripts/build-release.ts` is removed. The PATH fallback, the `dovet doctor` hint and the install-script hint are built with Grep, doctor and the install script (M1, M0-09).

### Q3 (M0-07): do snapshots use the user's git objects as an alternate?
- **What's missing:** checkpoints "Private object store" and ADR-19 had snapshots read the user's repository objects through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, so existing blobs would not be copied. In the prototype, a reviewer found that git then "freshens" an already-stored object by updating its modification time, which changes a file inside the user's `.git/objects` (the spec says nothing is written there), and that a checkpoint's tree can then refer to objects that only the user's repository holds, so a user's `git gc --prune=now` or history rewrite could make a rewind fail.
- **Recommended answer:** no alternate. The private store holds every blob itself. A checkpoint can always be restored, and nothing in `.git` changes, not even a timestamp. Cost: the first snapshot stores a compressed copy of the workspace (7.8 MB for 59 MB of source files in the 100,000-file benchmark); `dovet gc` still removes what no retained checkpoint needs.
- **Meanwhile:** built that way, marked `ASSUMPTION (QUESTIONS Q3)` in `src/store/snapshots/snapshotter.ts`. This spec-change PR applies it to checkpoints "Git tree snapshots" and ADR-19. It changes an ADR, so it waits for the owner. If you agree, just write "yes".

### Q4 (M0-07): how are new blobs written to the private store?
- **What's missing:** checkpoints "Snapshot (filter-free)" step 3 named `git hash-object --no-filters -w --stdin-paths`, which writes one loose object file per blob. Measured on GitHub's Windows runner (3,000 new files, C: drive): 23.3 s (7.8 ms per file); the same blobs through `git fast-import` into one pack: 0.28 s. The 100,000-file first snapshot took 13 minutes with `hash-object`. Git's `core.fsync` and compression settings made no difference. Linux is about 10 times faster with the pack too.
- **Recommended answer:** `git fast-import` with exact-length blobs, run in an empty bare repository of Dovet's own so a crash report can't land in the user's `.git` (the git docs say fast-import writes crash reports to the top level of the repository it runs in). Checkpoints step 3 and ADR-19's plumbing list now say so. Same filter safety (fast-import runs none; a test feeds it file content that looks like fast-import commands). This also corrects ADR-19's "(lint rule)" for forbidding `git add`/`checkout`: a test scans the module's source instead.
- **Meanwhile:** built that way in PR #13. This spec-change PR changes ADR-19, so it waits for the owner. If you agree, just write "yes".

### Q5 (M0-07 session): upgrade TypeScript to 7?
- **What's missing:** Dependabot opened PR #12 (`typescript` 6.0.3 → 7.0.2). Nothing in the specs says which version to use; PROGRESS (M0-01) records that it is pinned to 6.0.3 because `dependency-cruiser` needs `<7` (Bun's own `bun check` does the type check and needs no `typescript` package, ADR-1).
- **Findings:** with 7.0.2 the three import-boundary tests (AC-ARCH-04) fail: `dependency-cruiser` stops seeing TypeScript imports and exits cleanly on a forbidden import. Its own source and docs say "support for typescript@>=7 will follow when its API is published and stable"; its newest release (18.6.0) still caps at `<7`. TypeScript 7.0.2's package only exposes `unstable/*` APIs. Moving to 7 therefore means replacing the boundary checker (an ADR-22 change); Bun's import scanner omits type-only imports, so a replacement needs its own scanner for `import type` and `export type … from`.
- **Recommended answer:** stay on 6.0.3 and leave #12 unmerged until `dependency-cruiser` supports 7 or we replace it.
- **Answer (owner, 2026-10-12):** keep 6.0.3 for now, no upgrade; the owner will decide about PR #12. Applied: nothing changed; the agent did not touch #12.

### Q6 (M0-07 session): AC-CKPT-05's 200 ms budget on Windows
- **What's missing:** AC-CKPT-05 says a second snapshot of an unchanged 10,000-file repository takes under 200 ms. M0 measured on CI runners (20,000 files): Linux 190 ms, macOS 157 ms, Windows 498 ms (a repeat snapshot is as fast as `git status` or faster: Windows `git status` took 2.4 s). A Windows `git` process costs about 27 ms to start, and a snapshot starts about six, so Windows has a floor of about 160 ms before touching a file; 10,000 files is about 250 ms.
- **Recommended answer:** keep 200 ms for Linux and macOS and allow 400 ms on Windows, for the 10,000-file case on CI runners. Fewer processes (for example a long-lived `git cat-file`/`update-index` helper) is the fix if real use needs more, and it can wait.
- **Meanwhile:** nothing is built on it yet; the test for AC-CKPT-05 belongs to the M2 snapshot task, which applies the per-OS budget and puts it into the spec in its spec-change PR. If you agree, just write "yes".

### Q7 (M0-06): how strictly is the vendored pi-tui type-checked?
- **What's missing:** AGENTS.md says "TypeScript strict; no `any`", and Dovet's `tsconfig.json` adds three checks on top of `strict` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`). pi-tui is written for `strict` only: under Dovet's settings its 1.1.0 source has 221 errors in 20 files. Nothing says whether vendored code must meet Dovet's extra checks.
- **Answer:** vendored code is checked with its upstream's settings (`strict`), not Dovet's extras. Patching about 220 lines of someone else's code would turn every re-sync with pi-tui into a merge, and those three checks catch mistakes in code we write, not in a library that already has its own tests. `src/tui/vendor/pi-tui/tsconfig.json` is a separate TypeScript project (a project reference from the root, `bun check -b`), so Dovet's own code keeps every check, including where it calls pi-tui. Dovet's own changes inside the vendored copy are few and marked `Dovet:` (listed in its `VENDORED.md`). Biome already skipped `src/tui/vendor`.

### Q8 (M0-06, owner): Dovet's own background color
- **Owner decision (2026-10-12):** "we must have a background for the TUI itself, not rely on the terminal the user is running from." The spec only said the theme has light and dark variants matched to the terminal.
- **How it's applied:** tui "Rendering rules" now says Dovet paints its own background and default text color (setting only one of them makes text unreadable on some terminals). Choices the agent made: fullscreen paints the whole screen; inline mode paints the lines Dovet draws across the full width (rows it hasn't drawn and the shell prompt after exit can't be painted without taking over the screen); detection of the terminal's light/dark still picks the starting variant; no background with `NO_COLOR` or 16-color terminals (no way to choose a matching shade there). The demo in PR #17 shows it, so the owner's terminal run covers it.

### Q9 (M0-06 session, for the record): why the binaries are big
- **Question (owner):** the downloads are large though little is built yet.
- **Answer:** it is the Bun runtime, which every compiled Bun executable carries (ADR-1). Measured on Linux x64 with Bun 1.4.3: a one-line `console.log("hi")` compiles to 86.6 MB, `dovet` to 86.6 MB, `tui-demo` to 87.0 MB; Dovet's own JavaScript, minified, is about 0.3 MB. Windows: 91.9 MB for the one-liner. Compressed downloads are 31–42 MB. Size therefore stays roughly flat as Dovet grows. Shrinking the runtime (UPX-style packers) is not used: it breaks macOS code signatures and sets off antivirus scanners. Revisit only if Bun ships a smaller runtime.

