# Follow-ups

Pre-existing bugs a review found in code its task didn't change ([build loop step 7](../../workflow/build-loop.md)). Open `blocker` and `major` entries are fixed first, oldest first (step 2.4); `minor` ones wait for a task that touches the same code.

Format:

```
### F<n> (<task that found it>): <short title>
- **Severity:** blocker | major | minor · `file:line`
- <what fails, the input that shows it, the class of bug>
```

When fixed, move the entry to "Fixed" and add `- **Fixed:** #<PR>`.

## Open

## Fixed
