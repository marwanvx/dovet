Finds files by name pattern, relative to `path` (default: the working directory).

- `*.ts` matches files directly in `path`; use `**/*.ts` to match at any depth. Braces work: `*.{json,yaml}`.
- Returns up to 100 paths, most recently modified first. Narrow the pattern if results are truncated.
- Skips gitignored files. If nothing else matches, ignored files are searched and marked as such.
- Use Grep to search file contents.
