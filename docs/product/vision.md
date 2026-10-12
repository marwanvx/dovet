# Vision

## The problems (evidence from 2026)

| # | Problem | Evidence |
|---|---|---|
| P1 | **Hidden harness changes.** Users cannot see what the tool does to their model. | Anthropic's April 2026 postmortem: weeks of "Claude Code got worse" were traced to three hidden product changes (a lower default reasoning effort, a bug dropping reasoning history mid-session, a 25-word cap between tool calls). Users also found work silently routed to a cheaper model. |
| P2 | **Cost and quota surprises.** | Reports of a Codex weekly allowance drained in ~30 seconds; one security scan using half a Pro user's weekly quota; surprise Claude limits in January 2026. |
| P3 | **Vendor lock-in and outages.** | Codex "model at capacity" outages (Sept 2026); Google retired the open-source Gemini CLI for individual users (June 18, 2026) in favor of the closed Antigravity CLI; some subscriptions work only in the vendor's own tool. |
| P4 | **The agent claims work it did not do.** | "Codex tells me it updated a bash script, but it never does." 66% of developers cite "almost right" AI code; distrust rose from 31% (2024) to 46% (2026). |
| P5 | **Instructions get forgotten.** | AGENTS.md rules ignored; "ignores instructions, repeats mistakes"; 40% cite design drift. |
| P6 | **Review burden.** | Agents produce more code than people can review. |
| P7 | **Prompt injection.** | Aug 2026: a malicious GitHub issue reached CI secrets through two major CLIs. |

Sources: [sources.md](../background/sources.md).

## Thesis

> **The coding agent that can't lie to you about what it did, what it cost, or what it was told.**

The pattern behind P1–P6 is that users cannot *verify* the agent or the harness. Dovet makes every action, cost and instruction visible and checkable. Its edge is not on benchmarks; model makers tune models inside their own harnesses, so a third-party harness starts behind there. Dovet competes on what the labs don't optimize: **transparency, cost control, safety, and provider freedom.**

## The 7 pillars

| Pillar | Solves | One-line definition | Spec |
|---|---|---|---|
| **Glass box** | P1 | The system prompt, tools, model, effort and every request parameter are visible files and logged facts. Nothing changes silently. | [context](../specs/context.md), [event-log](../specs/event-log.md) |
| **Budgets** | P2 | A live cost meter, hard budgets, pre-flight estimates and loop detection. | [receipts-budgets](../specs/receipts-budgets.md) |
| **Provider freedom** | P3 | Any provider: Anthropic, OpenAI, Google, Chinese platforms, gateways and local models, all with the same tools and prompt. | [providers](../specs/providers.md) |
| **Receipts** | P4 | Turn summaries generated from the event log, with claims checked against what actually happened. | [receipts-budgets](../specs/receipts-budgets.md) |
| **Rules that stick** | P5 | Instructions are never compacted away; checkable rules are enforced by code, not prose. | [context](../specs/context.md), [permissions](../specs/permissions.md) |
| **Review-first** | P6 | Changes grouped per turn, with diffs, checkpoints and rewind. | [checkpoints](../specs/checkpoints.md), [tui](../specs/tui.md) |
| **Taint & sandbox** | P7 | An OS sandbox by default; untrusted content locks down risky actions. | [permissions](../specs/permissions.md) |

## Who it's for

- **Primary:** individual developers who want to choose their model provider, see what the agent does, and control what it costs.
- **Secondary:** developers who switch between providers or run local models.
- **Not (yet):** enterprises needing SSO, managed policies or audit exports.

**How users connect a provider:** every provider is connected through `/login` with the methods that provider officially allows for third-party tools ([cli-config "Connecting providers"](../specs/cli-config.md)):
- an **API key** (every provider that has one);
- an **account login** where the provider permits it for third-party tools, for example OpenAI's "Sign in with ChatGPT", which bills the user's ChatGPT plan;
- a **coding-plan key** where the provider sells one (several Chinese providers);
- **no credential** for local model servers.

Which methods a provider offers is data in the provider registry ([providers](../specs/providers.md)), not product logic. A login method is added only when the provider's terms allow it. For example, Anthropic account (Claude subscription) login is not offered, because Anthropic's terms don't permit it for third-party tools; Claude models are used with an Anthropic API key. If a provider's terms change, the registry changes, not the product.

## Non-goals (explicit "no" list)

These are refused unless an ADR overturns them:

- IDE extensions (ACP gives editor support instead, in v0.2), a desktop app, a web app.
- Dovet's own accounts, login servers or paid plans; telemetry by default.
- Enterprise features: SSO, managed settings, org policies.
- Any login method a provider doesn't officially allow for third-party tools (no reused browser sessions, no unofficial OAuth clients). The per-provider list of allowed methods is in [cli-config](../specs/cli-config.md) and is re-checked when a provider's terms change.
- Vector databases or "memory" abstractions. Memory is plain files.
- Pushing or publishing without the user's say-so: every push, publish or deploy command asks, unless the user wrote an allow rule for it or chose `bypassPermissions`; force-push to the default branch is denied unless an exact rule names it ([permissions §4.8, §5](../specs/permissions.md)).
- UI languages other than English in v0.1 (the claim checker's verb lists are English-only too).

## Success metrics for v0.1

| Metric | Target |
|---|---|
| Eval suite pass rate, per model family | Within 10 percentage points of the model vendor's own harness on the same tasks with the same model (Claude Code for Claude models, Codex for GPT models) |
| Cost per completed eval task | Equal to or lower than the vendor's own harness on the same tasks |
| Prompt cache hit rate in multi-turn sessions | ≥ 85% of input tokens read from cache after turn 3 |
| Silent behavior changes | Zero: every default change appears in the changelog and in `dovet --explain-defaults` |
| Startup time (compiled binary, warm disk) | < 300 ms to interactive prompt |
| Crash-free sessions in soak test (4 h) | 100%, with memory growth < 200 MB |
