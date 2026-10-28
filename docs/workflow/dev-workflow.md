# Development Workflow (building Dovet with AI agents)

AI agents will write most of Dovet's code. These rules exist because agents are confident, fast, and frequently wrong in small ways.

## The loop for every piece of work

Agents run this loop through [build-loop.md](build-loop.md), which also covers picking tasks, handing off between sessions and asking the owner; the owner's side is in the [playbook](playbook.md).

1. **Pick one task** from the current milestone. A task is small: one spec section or one acceptance criterion group. Never "implement the agent loop" in one go.
2. **Agent reads the spec section first**, plus every doc it links to. The task prompt names the spec file and section.
3. **Tests first** for the acceptance criteria in scope: the agent writes failing tests named after the criteria (`// spec: AC-TOOLS-04`).
4. **Implement** until the tests pass.
5. **Run the full quality gate locally:** `bun run check` = `bun check` (type check) + Biome lint + dependency-direction check + all tests + spec-coverage + docs + wiring checks. Every step runs even when one fails, and the summary names each result.
6. **Self-review:** the agent re-reads its diff against the spec section and lists any deviation. Deviations are fixed or turned into a spec-change proposal (never silently kept).
7. **Fresh review:** a separate reviewer session or subagent checks the diff against the spec; findings are fixed.
8. **Merge** when CI is green on all three OSes and the review passed. PRs that change decisions (ADRs, roadmap, product decisions) or need an owner step wait for the owner.

## Rules for the agent (the repo's AGENTS.md holds the same rules; CLAUDE.md imports it)

- The specs in `docs/` are the source of truth. If something is unclear or seems wrong, don't invent behavior silently: decide the best answer, record it in `docs/plan/tasks/QUESTIONS.md` and write it into the spec in the same PR (build loop step 6).
- Never use a library API from memory. Check the installed package's types or docs. If an external fact isn't in the spec, mark it `[SPIKE]` and resolve it before building on it.
- No new dependency without an ADR entry in `docs/plan/decisions.md`.
- No `any`, no `as` casts except at zod-validated boundaries, no `@ts-ignore` (`@ts-expect-error` with a reason only for SDK typing lag, as Anthropic's docs suggest for new beta blocks).
- No catch-and-ignore. Every caught error is handled, rethrown, or logged with context.
- **Few comments.** Comments only where the code can't say it: a non-obvious *why*, a workaround, a security-critical line, a `// spec:` tag. Never restate the code, narrate steps, or repeat what a name or type says; a file header is one line at most. Comments cost tokens in every later session (owner rule).
- No new abstraction until three real uses exist. Prefer a plain function.
- Don't modify tests to make them pass unless the test contradicts the spec, and say so explicitly.
- Every bug fix includes a regression test.
- Keep PRs under ~400 changed lines (tests excluded) unless the task explicitly allows more.
- When done, report: what changed, which acceptance criteria now pass, anything not done, and any spec ambiguity found.

## Spec changes

- A requirement is written in the spec of its feature, never only in `docs/plan/` (decisions, roadmap, open questions), the user journeys or `docs/background/`. After editing any of those, or adding a `[SPIKE-n]`/ADR reference, run `bun run docs:boxes` to refresh the "Before you build" boxes, then `bun run docs:check` (CI runs the same check).

- An answer to a spec gap (a `QUESTIONS.md` entry) is written into the spec in the same PR as the code that needs it.
- A change to a decision (an ADR, the roadmap, a product decision) is its own PR touching `docs/`, with an ADR, and waits for the owner; code that depends on it follows after it merges.
- When an external fact is re-verified, update its `[VERIFIED date]` marker; record the evidence in `docs/background/feature-research.md`.

## Avoiding wasted tokens while building

- Give agents the exact spec section and file paths; don't ask them to "explore the codebase".
- Use cheaper/faster models for mechanical tasks (renames, test scaffolding, fixture updates) and the strongest model for design-heavy tasks (agent loop, policy engine, transcript builder).
- Re-record provider fixtures only when a provider's behavior changes, not per PR.
- Evals run only for prompt/tool/default changes and before releases, with an approved budget.
