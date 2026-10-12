# Contributing to Dovet

Thank you for helping. Dovet is built spec-first: the specs in [`docs/specs/`](docs/specs/) say what to build, and code follows them.

## What you need

Only [Bun](https://bun.sh) (1.4.3 or newer). Then:

```
bun install
bun run check     # type check, lint, import boundaries, tests, spec coverage, docs check
bun run next      # the next task and the exact spec text it needs
```

## How a change is made

Every change follows the loop in [docs/workflow/dev-workflow.md](docs/workflow/dev-workflow.md):

1. Pick one task from the current milestone's list in [`docs/plan/tasks/`](docs/plan/tasks/).
2. Read the spec sections the task names (`bun run next <task-id>` prints them).
3. Write tests first, tagged with the acceptance criterion they prove (`// spec: AC-TOOLS-04`), and see them fail.
4. Implement until they pass; `bun run check` must pass.
5. Open a pull request using the template: task, spec sections, criteria covered, spec questions found.

If a spec is unclear or seems wrong, don't guess: say so in the PR, or open an issue. A spec change is its own PR.

## Pull request rules

- One task per PR, under about 400 changed lines (tests excluded).
- CI must be green on Linux, macOS and Windows.
- No new runtime dependency without an entry in ADR-15 ([decisions](docs/plan/decisions.md)).
- Changes to decisions, the roadmap or open questions in `docs/plan/` need the owner's approval (see `.github/CODEOWNERS`).
- Copied code keeps its license notice, and the PR says so.

## AI-written pull requests

Welcome, under exactly the same rules. [AGENTS.md](AGENTS.md) holds the instructions for coding agents.

## License

There is no contributor license agreement. By opening a pull request you agree that your contribution is licensed under the [MIT license](LICENSE), the same as the project.
