# Questions for the owner

Agents add questions here when only the owner can decide ([build loop](../../workflow/build-loop.md) step 6). Answer under "Answer:" in plain words; the next session applies it.

## Waiting for the owner

### Q1 (M0-01): Dependabot ecosystem for the package updates — ASSUMPTION built
- **What's missing:** architecture "Repository layout" says dependabot updates "npm (grouped, weekly)". Dovet keeps its dependencies in Bun's lockfile (`bun.lock`), which Dependabot's `npm` setting doesn't update, so its PRs would fail CI.
- **Recommended answer:** use Dependabot's `bun` setting (same weekly, grouped updates). The spec line then reads "Bun packages (grouped, weekly)".
- **Meanwhile:** built that way, marked `ASSUMPTION` in `.github/dependabot.yml`. If you agree, just write "yes".

Answer:

## Answered

 use Dependabot's bun setting (same weekly, grouped updates). The spec line then reads "Bun packages (grouped, weekly)".
