# What a Dovet review looks for

Every reviewer reads this; [build loop step 7](docs/workflow/build-loop.md) says how rounds run.

## What "broken" means here

Dovet's promise is that the agent can't hide what it did, what it cost, or what it was told. A change is broken when:

- **a guard can be walked around**: a command, path or tool call the policy should stop gets through (wrapped commands, `xargs`, `env`, symlinks, `..`, other casing, Windows drive and UNC paths);
- **a secret leaks**: into the transcript, a log, an error message or a test fixture, including Unicode and hidden-character tricks;
- **the record lies**: the event log, cost or a status line says something that did not happen;
- **it only works on the author's OS**: path separators, drive letters, case-insensitive matching, `EBUSY`, POSIX-only shell assumptions. Compare and join paths through `src/platform/paths.ts` (`lexicalPath`, `pathKey`, `isWithin`), never with string slicing.

## High-risk paths

A diff touching any of these gets the `deep` tier: `src/policy/**`, `src/store/secrets/**`, `src/cli/sandbox.ts`, `src/cli/update.ts`, `src/cli/release-signature.ts`, `src/cli/auth.ts`, `.github/workflows/**`, `scripts/build-release.ts`, `scripts/sign-release.ts`, `docs/prompts/**`.

## Findings

- **Evidence or it isn't a finding:** `file:line`, and either the failing input or the command you ran. A guess from a name is not a finding.
- **Tag each one** `blocker`, `major`, `minor` or `nit`, and add `pre-existing` when the bug is in code this diff didn't change (`git blame` shows an older commit). Pre-existing findings are logged, not fixed in this task.
- **Name the class of bug**, not only one line, so the fix covers every instance ("every caller that compares paths with `startsWith`").
- **At most three nits.** Style preferences and cases that can't happen are not findings.
- **Don't repeat** a finding from an earlier round that was fixed or answered.
- **Start your report with the count**, e.g. `2 findings: 1 major, 1 minor`, or `0 findings above minor` when there is nothing to fix.

## Skip

`docs/background/**`, `research-cache/`, generated files (`bun run docs:boxes`, `bun run gen:schemas` output), lockfiles.
