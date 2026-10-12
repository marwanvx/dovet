Presents your plan to the user for approval. If they approve, plan mode ends and you implement the plan in the mode they chose. Use it only in plan mode, once the plan is complete, and only for tasks that change things; for questions or research, just answer.

The plan is read from the plan file. Write the plan there first (Write or Edit), then call this tool with no arguments. You may pass `plan` (Markdown) instead; it replaces the plan file's content.

If the user keeps planning, their feedback is returned: revise the plan file and call this tool again. Don't use AskUserQuestion to ask whether the plan is okay; this tool is how the user approves it.
