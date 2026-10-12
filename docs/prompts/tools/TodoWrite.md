Creates and updates the task list for the current work. The user sees it live, and it helps you keep track of multi-step work.

- Use it when the work has 3 or more distinct steps, when the user gives several tasks at once, or when new steps come up while you work. Skip it for single-step or trivial requests.
- Send the whole list each time: each item has `content` (imperative, e.g. "Add retry to the upload client"), `activeForm` (e.g. "Adding retry to the upload client") and `status` (`pending`, `in_progress`, `completed`).
- Keep exactly one item `in_progress`. Mark an item `completed` as soon as it's actually done (checked, not just written), and only then start the next. If something blocks an item, keep it `in_progress` and add an item for the blocker.
- Update the list when the plan changes: add, remove or reorder items. Before you finish, every item should be `completed` or removed with a reason given in your message.
