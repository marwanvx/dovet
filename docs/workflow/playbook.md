# Playbook: building Dovet with AI agents

For the owner. It adds no requirements; it explains how to drive the agents. The agents' own procedure is the [build loop](build-loop.md).

## The one prompt

Open a **new** session in the repository and send:

```
Continue building Dovet.
```

That's all, every time. The agent reads where things stand from the repository (task lists, progress log, open PRs), finishes or fixes anything left over, picks the next task itself, builds it, has it reviewed by a fresh reviewer, merges it when CI is green, logs what it did, and tells you in three sentences. Then you start a new session with the same prompt.

**Want it to do several tasks in a row?** Send `Continue building Dovet. Keep going.` With a tool that supports subagents (Claude Code does), the session hands each task to a fresh subagent and stops at a step that needs you, the end of a milestone, or after 5 tasks.

## Your job

1. **Nothing to answer.** When the specs don't decide something, the agent decides it and records question and answer in [tasks/QUESTIONS.md](../plan/tasks/QUESTIONS.md). Read them if you like; to change one, tell the agent (or add an `Override (owner)` line to the entry) and the next session applies it.
2. **Do the owner steps** the agent asks for (create the GitHub repository, run the TUI demo on your terminals, create the release key). It tells you exactly what to click or type.
3. **Read the three-sentence summary** at the end of each session. Nothing else is required. [tasks/PROGRESS.md](../plan/tasks/PROGRESS.md) has the full history if you want it.
4. **Approve plan changes:** PRs that change decisions (ADRs, roadmap, product decisions) wait for you. Everything else merges itself after review and green CI on all three OSes.

## When you want something different

- **A new idea or a change:** send `I want to change: <your idea in plain words>. Follow the spec-change rules in docs/workflow/dev-workflow.md and open a PR for me to approve.` It lands in the right spec, and the build loop builds it when its milestone comes.
- **You found a bug:** send `Bug: <what happened>. Fix it following docs/workflow/build-loop.md step 6.` (Paste `dovet bug` output once that exists.)
- **Where are we?** send `Summarize the project state in plain words. Don't change anything.`

## One-time setup

1. **A GitHub account** and **a coding agent**. Claude Code is the best fit: this folder has `.claude/settings.json`, which lets it run routine build commands (bun, git, GitHub PRs) without asking you each time, while force-pushes and pushes to `main` stay blocked. With another agent (Codex, OpenCode…), set its approval mode to allow commands inside the project folder, or you'll be asked to approve every test run.
2. **Use one strong model for everything** (the most capable one your plan offers). Switching models per task saves little and makes results uneven.
3. Open the agent in this folder and send the one prompt. Task M0-01 installs Bun and the GitHub CLI if they're missing (no admin password needed), The GitHub repository already exists.

**What you'll be asked for later, so it's no surprise:**

| When | What | Cost |
|---|---|---|
| M0-06 | Run a small demo program on the terminals you have, ~30 min | — |
| M0-09 | Create the release signing key (the agent gives every step) | — |
| M1-30 | Your free NVIDIA key (`NVIDIA_API_KEY`) as a GitHub secret for nightly tests | free |
| M3-14 | Use Dovet as your daily coding agent for two weeks | — |
| M5-01 | Install Docker | free (evals use free NVIDIA models) |
| M5-05 / M5-06 | Follow the docs on a fresh setup; approve the release | — |

GitHub Actions (tests on Linux, macOS and Windows for every PR) is free for public repositories.

## The right way to work

These come from the systems that already do this well: Anthropic's guide to long-running coding agents, and GSD's context-engineering workflow (see Sources).

- **New session for every task.** Quality drops as a conversation grows ("context rot"); a fresh session that reads the progress files works better and costs less than a long one.
- **The files are the memory, not the chat.** Decisions you make in conversation are lost when the session ends unless they land in a spec or `QUESTIONS.md`. That's why the agent writes them down.
- **One task, one PR, small.** Big tasks make agents run out of room halfway and leave half-built code.
- **Tests first, then code, then a separate reviewer.** The agent that wrote the code is the worst judge of it; a fresh reviewer finds what it missed.
- **CI decides "done", not the agent.** A task is done only when tests pass on Linux, macOS and Windows.
- **Strong model for hard parts, cheaper model for easy ones.** The agent loop, permissions, transcript and provider adapter deserve the best model; renames, test fixtures and docs don't.

## The wrong ways (they cost tokens for nothing)

- **"Build the whole thing" in one session.** It runs out of context mid-way and leaves a mess the next session has to clean up.
- **Pasting docs into the chat**, or asking it to "read all the docs" or "explore the codebase". The task list already names the 2–3 sections each task needs.
- **Continuing a long session that keeps failing.** Start a new one; the repository has everything it needs.
- **Overriding an agent's answer in the chat only.** Ask the agent to record it in `QUESTIONS.md` (or add the `Override (owner)` line yourself), or the next session follows the old answer.
- **Adding ideas mid-milestone directly to the code.** Use the change prompt; otherwise the plan and the code drift apart and agents start chasing things the specs don't say.
- **Letting an agent "fix" a test or a spec so its code passes.** The build loop forbids it; if you see it in a summary, reject the PR.
- **Running several agents on the same task or files at once.** They overwrite each other. One session at a time until the project is further along.
- **Asking for features outside the current milestone.** "Quick" extras skip the plan, the tests and the review.

## Sources

- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): one feature per session, a feature list and progress file as memory, start every session by reading them and checking the build, end with a commit and a progress note.
- GSD Core ([open-gsd/gsd-core](https://github.com/open-gsd/gsd-core)): fresh-context subagents against context rot, `STATE.md` as the memory between sessions, a plan checker before building, and a verify step before a phase counts as done.
