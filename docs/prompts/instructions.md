# Fixed mid-epoch instruction texts (placeholders in <angle brackets>)
# Delivery: [context §4](../specs/context.md). Harness texts are never placed in the same content block as the user's words.

interrupt-note: The user interrupted your response. Blocks that finished are kept above; the rest was discarded.
continue-after-drop: Your previous response was cut off by a connection error after the blocks above. Continue from there.
mode-plan: <contents of modes/plan.md; <plan file> filled in>
mode-acceptEdits: <contents of modes/acceptEdits.md>
mode-default: <contents of modes/default.md>
mode-dontAsk: <contents of modes/dontAsk.md>
mode-bypassPermissions: <contents of modes/bypassPermissions.md>
sandbox-changed: <contents of modes/sandbox-on.md or sandbox-off.md>
plan-approved: The user approved the plan<, after editing it; the approved version is in <plan file>>. Implement it now.
plan-not-approved: The user hasn't approved the plan yet.
plan-left: The user left plan mode without approving the plan.
plan-reattach (after compaction, while planning or implementing an approved plan): The current plan (<plan file>):\n<content>
restore-note: The user restored files to their state before turn <k>. Re-read files before editing them.
instructions-updated: Instructions updated (<path>):\n<content>
lazy-instructions: Instructions for <dir> (loaded because you worked with files there):\n<content>
user-shell-output: The user ran `<command>` (exit <code>):\n<output>
silence-reminder: The user hasn't heard from you in a while — say in a few words what you're doing, then continue.
open-tasks (headless only): Your task list still has open items: <items>. Continue with them. If one is blocked, say what is blocking it.
budget-warning: (only if budget.notifyModel) The session has used <pct>% of its budget.
