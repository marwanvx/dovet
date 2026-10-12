Replaces text in an existing file by exact string match.

- `old_string` must match the file's text, including whitespace and indentation, and must appear exactly once, unless `replace_all` is true. Copy it from the Read output without the line-number prefix, and include enough surrounding lines to make it unique.
- Read the file (or view it with a single-file `cat`/`head`/`sed -n`/`grep`) before editing it.
- Prefer the smallest unique `old_string` that pins the location. Use `replace_all` to rename something throughout the file.
- If the file changed since you read it, the edit still applies when `old_string` matches the current text; otherwise read the file again. If an indentation difference is the only mismatch, the tool may still find the place and will say so.
- If no match is found, the error shows the closest text in the file; correct `old_string` from it.
- Files that aren't UTF-8 (or UTF-16 with a byte-order mark), and files over 50 MB, can't be edited with this tool; use a shell command that preserves the encoding, or ask the user.
- To create a file, use Write. Never put placeholders like "… rest unchanged" in `new_string`.
