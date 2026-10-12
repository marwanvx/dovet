# Prompts

**One prompt set for every model.** Claude, GPT, Gemini, DeepSeek, Qwen, Kimi, GLM, local models: all get the same system prompt, the same tools and the same tool descriptions. Dovet is provider-neutral, so its behavior must not depend on which company made the model, and one set is one thing to test, review and keep honest (glass box). A per-model variant is added only if evals ([testing](../specs/testing.md)) show a real gain for that model that the shared text can't get, and then by an ADR; model *settings* (effort, thinking display, sampling) are data in the provider registry and catalog ([providers](../specs/providers.md)), never prompt text.

**Status: drafts.** Final wording is decided by evals; every change is versioned and hashed into `epoch.start` (glass box).

## How the system prompt is assembled (in this order)

The prompt is assembled once per epoch and stays byte-stable for the epoch (cache, [context §2](../specs/context.md)):

1. **Base prompt:** `system.md`.
2. **Session state** from `modes/`: the current permission mode, the sandbox state, and `headless.md` when nobody can answer (headless or `dontAsk`), so the model knows what will be asked and what will be refused.
3. **Conditional sections** from `conditional/`, only when they apply: `websearch.md` (WebSearch available), `git-attribution-trailer.md` (`git.attribution: "trailer"`).
4. **Environment block** and **Project instructions** ([context §2–3](../specs/context.md)).

**Mode texts never conflict:** in plan mode, `plan.md` states that it takes precedence over "act on requests" and over headless autonomy.

**Mid-epoch changes** (a mode switch, sandbox state, instruction files) are never edits to the system prompt. They arrive as mid-epoch instructions using the texts in `instructions.md`; mode texts are the same files as in step 2, so the model sees identical wording either way.

## Rules for every prompt file
- **Written for any model:** no vendor names, no vendor-specific tool names or formats, no wording that only one model family understands. Small local models must be able to follow it too: concrete steps, plain words.
- **No per-request values** (dates, times, names, IDs, random values); dynamic facts go in the Environment block or mid-epoch instructions.
- **Calm, direct wording.** Current models follow instructions closely; aggressive emphasis ("CRITICAL", all caps) makes them overuse tools or rules. State what to do and why, briefly.
- **Say what to do, not only what to avoid.**
- **No instructions to reveal reasoning in the reply**; the harness reads reasoning summaries from the provider's reasoning output.
- **Each tool description states:** what it does, when to use it instead of alternatives, its limits, and its error behavior.
- **Length:** `system.md` under ~2,500 tokens.

| File | Used for |
|---|---|
| `system.md` | The base prompt |
| `modes/*.md` | Permission mode, sandbox state, headless (step 2; also mid-epoch texts) |
| `conditional/*.md` | Conditional sections (step 3) |
| `tools/*.md` | One description per tool, for every model |
| `tools/Bash.md`, `BashGitBash.md`, `PowerShell.md`, `PowerShell51.md` | Shell variants: the one matching the **detected shell** is used ([tools §5–6](../specs/tools.md), [platforms](../specs/platforms.md)); this depends on the user's machine, not the model |
| `compact.md` | Compaction request ([context §6](../specs/context.md)) |
| `instructions.md` | Fixed texts of mid-epoch instructions |
| `init.md` | `/init` task prompt |
