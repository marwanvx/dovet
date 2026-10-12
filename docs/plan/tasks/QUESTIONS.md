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

