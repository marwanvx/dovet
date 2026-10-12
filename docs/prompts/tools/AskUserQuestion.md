Asks the user 1–4 multiple-choice questions when a decision is genuinely theirs and you can't settle it from the request, the code, or a sensible default. Before asking, do the work that doesn't depend on the answer.

- Each question has a short `header` (12 characters or fewer), the question, and 2–4 distinct options, each with a short label and a one-line description. The user can always answer in their own words instead.
- If you recommend an option, put it first and add "(Recommended)" to its label.
- Don't use it to ask permission to proceed, to confirm a plan (use ExitPlanMode in plan mode), or for questions you could answer by reading the code.
- When nobody can answer (unattended runs), it returns an error: choose the most sensible option yourself and state your assumption.
- An option may carry a `preview` (Markdown, e.g. a short code sample) when comparing concrete alternatives helps the user choose.
