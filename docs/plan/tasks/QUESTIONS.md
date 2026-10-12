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
