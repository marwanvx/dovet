# User journeys (product-level gap check)

This file holds no requirements of its own; each step points to the spec that does. Feature specs can each be complete while something a person needs sits *between* them (for example, an in-app way to connect a provider). This file walks through every stage of a user's life with Dovet and points each step to the spec that covers it. **Any step without a spec link is a gap: raise it, don't improvise.** Every new user-visible feature adds or updates a row here, and every release review re-walks the table.

| # | Journey step | Covered by |
|---|---|---|
| 1 | Find, download and verify Dovet on Windows, macOS or Linux | [architecture Distribution](../specs/architecture.md), [cli-config Install](../specs/cli-config.md) |
| 2 | First launch: connect a provider (any in the registry, incl. Chinese platforms and coding plans), choose a login method the provider permits, pick a model (a budget is optional) | [cli-config "/login", First-run wizard](../specs/cli-config.md), [providers Provider registry](../specs/providers.md) |
| 3 | Coming from Claude Code: existing CLAUDE.md and permission rules just work | [cli-config "Coming from Claude Code"](../specs/cli-config.md), [context §3](../specs/context.md) |
| 4 | Trust a cloned repository (or not) | [permissions §11](../specs/permissions.md), [cli-config precedence](../specs/cli-config.md) |
| 5 | Type a request: multi-line, paste images and large text, name an image file for the agent to look at, `@`-mention files, `!` shell commands; IME input (CJK); resize, suspend (Ctrl+Z) and quit leave the terminal clean | [tui Input modes](../specs/tui.md), [tui Terminal I/O robustness](../specs/tui.md), [tools §1](../specs/tools.md) |
| 6 | Watch the agent work: streaming text, progress notes, the task list, live command output, status, context and cost | [tui Task list](../specs/tui.md), [tools §12](../specs/tools.md), [providers §3 display](../specs/providers.md), [agent-loop Harness messages](../specs/agent-loop.md), [receipts-budgets](../specs/receipts-budgets.md) |
| 7 | Work with few prompts: in-project work runs freely inside the sandbox; prompts appear only when crossing a boundary (new host, outside write, push/publish/deploy), each saying which boundary; approve or deny, set rules so the same thing isn't asked again, and check rules with examples | [permissions §0b, §1–6, §4.8](../specs/permissions.md) |
| 8 | Stop the agent, change direction, or queue a follow-up while it works | [agent-loop Interrupts, Queued input](../specs/agent-loop.md) |
| 9 | Switch model, provider or effort mid-session | [tui `/model`, `/effort`](../specs/tui.md), [context §5](../specs/context.md), [providers](../specs/providers.md) |
| 9b | Answer the agent's questions (multiple choice, notes, own words) or dismiss them and type instead | [tools §4](../specs/tools.md), [tui Question dialog](../specs/tui.md) |
| 10 | Plan first, then let it implement: enter with Shift+Tab or `/plan <task>`, answer questions, edit the plan in the editor (Ctrl+G), approve into the mode they want, or keep planning; the plan survives compaction, resume and forks; works the same with every model | [tools §11](../specs/tools.md), [permissions §2](../specs/permissions.md) |
| 11 | Review everything the agent changed | [tui `/diff`](../specs/tui.md), [receipts-budgets receipts](../specs/receipts-budgets.md) |
| 12 | Undo changes or go back in the conversation | [checkpoints Rewind](../specs/checkpoints.md) |
| 13 | Commit the work (attribution choice) | [context §2 Git commits](../specs/context.md) |
| 14 | Long session: context fills up, compaction, continuing | [context §5–6](../specs/context.md) |
| 15 | Hit a provider limit, an outage or a rate limit; see limits and usage | [providers §7](../specs/providers.md), [tui `/usage`](../specs/tui.md) |
| 16 | A model gets deprecated or retired | [providers Model lifecycle](../specs/providers.md) |
| 17 | Spending: see costs, set budgets, plan-billed usage, spending history by day/project/model | [receipts-budgets](../specs/receipts-budgets.md), [cli-config Glass box for subscriptions, `dovet cost`](../specs/cli-config.md) |
| 18 | Exit, then come back later and resume; rename sessions | [tui `/exit`, `/rename`](../specs/tui.md), [event-log Resume](../specs/event-log.md) |
| 19 | Crash, kill or power loss, then recover | [event-log Crash recovery](../specs/event-log.md), [agent-loop signals](../specs/agent-loop.md) |
| 20 | Use it in scripts or CI | [tui Headless](../specs/tui.md), [interfaces §10](../specs/interfaces.md) |
| 20b | Search the web with any model, including local and Chinese providers | [tools §10 backends](../specs/tools.md), [cli-config Search services](../specs/cli-config.md) |
| 21 | Work offline or behind a corporate proxy | [cli-config Data and privacy, `--offline`](../specs/cli-config.md), [providers §6b](../specs/providers.md) |
| 22 | Know what data leaves the machine | [cli-config Data and privacy](../specs/cli-config.md) |
| 23 | Customize: theme, notifications, settings, instructions, rules | [cli-config Settings](../specs/cli-config.md), [tui](../specs/tui.md), [context §3](../specs/context.md) |
| 24 | Something's wrong: diagnose and report it, with or without a GitHub account | [cli-config `dovet bug`, `doctor --report`](../specs/cli-config.md) |
| 25 | Update, roll back, clean up disk, uninstall | [cli-config Install/update](../specs/cli-config.md), [event-log Disk use](../specs/event-log.md) |
| 26 | Several sessions or several projects at once | [event-log single writer](../specs/event-log.md), [checkpoints conflict safety](../specs/checkpoints.md), [interfaces §9](../specs/interfaces.md) |
| 27 | Accessibility: screen reader, reduced motion, no color | [tui Accessibility](../specs/tui.md) |

**Deliberately later (v0.2), so not gaps:** editor integration (ACP), MCP servers, hooks, skills and custom commands, subagents, background tasks, vim mode, custom keybinding files, custom status-line command, output styles.

**Not offered (provider terms):** Claude account (Pro/Max) login, Google AI Pro/Ultra (Antigravity) login, GitHub Copilot and xAI subscription logins; each returns only if the provider explicitly allows third-party tools ([cli-config "Connecting providers"](../specs/cli-config.md)).
