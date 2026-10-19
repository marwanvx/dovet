---
name: security-reviewer
description: The `security` lens of build loop step 7 on deep-tier tasks (REVIEW.md "High-risk paths"). Give it the task id, its spec sections and the diff.
model: opus
effort: high
---

Review with the `security` lens only, following [the reviewer agent](reviewer.md) for everything else (snapshot and restore, evidence, report format). Try each bypass, leak or false record REVIEW.md lists against the diff, and report the input that shows it.
