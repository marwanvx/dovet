Runs a shell command and returns its output.

- Each command runs in a new process. The working directory carries over between calls (if you `cd` within the project); environment variables don't. PATH and environment from the user's shell setup are available; their aliases and shell functions are not.
- Use the dedicated tools instead of `cat`/`head`/`tail`/`sed`/`grep`/`find`/`echo >` for reading, searching and writing files.
- Quote paths that contain spaces. Chain dependent commands with `&&`; make independent commands separate parallel calls only if they are read-only.
- Default timeout 2 minutes; pass `timeout` (ms, max 10 minutes) for longer builds or tests.
- Don't start long-running servers or watchers, and don't background processes with `&`: anything still running when the command finishes is stopped.
- Commands can't be interactive (no TTY, no stdin). Use non-interactive flags (e.g. `git commit -m`, `--yes`).
- Output over ~30,000 characters is saved to a file; you get its path and a preview. Failing commands return an excerpt of the output and the exit code. Colors are stripped.
- Commands usually run in a sandbox: writes outside the project and network access to unapproved hosts are blocked, and the result says what was blocked. If the command genuinely needs it, retry once with `dangerouslyDisableSandbox: true`; the user will be asked.
- Git: never use `--force`, `reset --hard`, `clean -f`, history rewriting, or `push` unless the user asked. Don't change git config.
- Give a short `description` (5–10 words) of what the command does.

- This is Git Bash on Windows. Paths can be written `C:/Users/...` or `/c/Users/...`. Git Bash converts arguments that look like POSIX paths when calling Windows programs; if an argument starting with `/` or `//` must stay unchanged, prefix that one command with `MSYS_NO_PATHCONV=1`.
