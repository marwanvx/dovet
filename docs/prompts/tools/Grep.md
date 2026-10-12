Searches file contents with ripgrep.

- `pattern` is a ripgrep regular expression (escape regex characters, e.g. `interface\{\}`).
- Narrow with `path`, `glob` (e.g. `**/*.ts`) or `type` (e.g. `py`, `rust`).
- `output_mode`: `files_with_matches` (default, paths only), `content` (matching lines grouped by file, with line numbers; use `-A`/`-B`/`-C` for context), or `count`.
- Results are limited by `head_limit` (default 250); use `offset` to page.
- Respects .gitignore and similar ignore files. To search an ignored directory (e.g. `node_modules/some-package`), pass it as `path`.
- Searches stop after 20 seconds and return partial results; narrow the search if that happens.
- Prefer this over running grep or rg in the shell.
