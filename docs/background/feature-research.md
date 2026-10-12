# Feature Research Log

> **Background, not a spec.** Written while the product's codename was "Glass"; it is now **Dovet**. This file records research and history: what was checked, where, and why decisions were made. It may describe earlier states of the plan. The specs (00–19, 21, 23, prompts/) are the source of truth; if this file disagrees with them, the spec wins.

One entry per feature, researched **one at a time** against the public record (other harnesses' source and docs, bug trackers, benchmarks, provider docs). Each entry answers: what the best tools do, what went wrong for them, which scenarios Glass must handle, the decision, and what changed in the spec. A feature is "done" here when its spec section was rewritten or confirmed from this evidence.

**Order:** build order (M1 first), because those specs are implemented first.

**Reference tools (2026-10-11):** Claude Code, Codex, OpenCode and Pi (and oh-my-pi). **Gemini CLI is retired** (replaced by the closed-source Antigravity CLI on 2026-06-18); older Gemini CLI evidence is used only as historical data, never as a current design reference.

**Glass is for every provider (owner, 2026-10-11).** Claude Code is the main teacher, not the target. For every lesson, the question is how it applies to **each provider family**: Anthropic, OpenAI, Google, Chinese platforms (DeepSeek, Qwen, Kimi, GLM, MiniMax, …), gateways and local models. Provider-specific behavior goes into the provider registry as data, never as Claude-only logic.

**Type 1 vs Type 2 (owner, 2026-10-11, first-principles review):** the changelog method below is for **Type 2** (reversible) decisions. **Type 1** decisions (the one-way doors in [decisions](../plan/decisions.md)) are derived from first principles, with other tools as corroboration only.

**Attribution (owner, 2026-10-11):** specs and prompts name other tools only where Glass copies their code. This log names them as research evidence (where a behavior was checked), not as credit.

**Method (revised 2026-10-11, after the owner's review):** a bug report shows a problem *as of its date*. Every problem cited here is checked against **Claude Code's official changelog** (`anthropics/claude-code/CHANGELOG.md`, read up to v2.1.296). Where Claude Code shipped a fix, the **fix is the evidence**: it is the current, tested solution, and Glass adopts it or deliberately diverges with a stated reason. Old blog posts and unresolved reports only motivate a scenario; they never decide a design on their own.

## Changelog cross-check of researched features

| Problem cited | Claude Code's shipped fix | Glass |
|---|---|---|
| Edit replaced curly quotes with straight ones | 2.1.47: preserves them | Same outcome: unchanged lines keep original bytes (tools §3.6) |
| Edit/Write doubled CRLF, stripped trailing-space hard breaks | 2.1.89 | EOL preserved; unchanged lines byte-exact |
| Edit failed after an external change even if the text still matched uniquely | 2.1.208: relaxed staleness | Same (tools §3.5) |
| Edit treated a changed file as read when mtime didn't move | 2.1.295: content check | Staleness by content hash (tools §3.5) |
| Write required a prior Read | 2.1.228: newer models may overwrite unread files | Same relaxed rule (tools §2.2); Glass additionally refuses when a *read* file changed since (tools §2.3) |
| Write into an existing directory ended the turn as "declined" | 2.1.277: clear error | Same (tools §2.8) |
| **Write through a planted hard link** | 2.1.285 (refused for its own output files) | **Glass's earlier in-place rule was unsafe**; now breaks the link by default (tools §2.7) |
| Read "unchanged" stubs after rewind | 2.1.260: clears read tracking on rewind | Dedup only for results on the current branch and epoch, by content hash (tools §1.5) |
| Read hung on named pipes | 2.1.280 | Regular files only (tools §1.1) |
| Whole-file reads blocked past the limit | 2.1.296: `allow_large` | Same option (tools §1.4) |
| PDF page lists silently returned only the first entry | 2.1.292: error | Same (tools §1.7) |
| Grep/Glob said "no matches" on failures (unreadable path, out of resources, 20 MB floods) | 2.1.275, 2.1.277, 2.1.292: errors | Same (tools §7) |
| Glob ignores `.gitignore` (timeouts, noise) | No change; an undocumented env var | Glass diverges: respects ignores, falls back (tools §8) |
| Shell snapshot bugs | Fixed individually: 2.1.47, 2.1.147, 2.1.246, 2.1.108; still replays functions | Glass takes the simpler env-only path, a reversible choice (tools §5.2) |
| Bash hid a full disk behind "Exit code 1" | 2.1.282 | Same (tools §5.5) |
| SIGTERM orphaned a running command's tree | 2.1.212 | Already in the signals table (agent-loop) |
| PowerShell failed on paths > 260 chars | 2.1.271 | Short temp paths (tools §6, 15) |
| `-EncodedCommand` blocked by EDR | Issue marked resolved, no changelog entry found | Never used (tools §6) |
| Resume failed every request: empty text blocks; proxy-written blocks | 2.1.277, 2.1.246: normalized at render | Same normalization (providers §3), repair epoch as last resort (event-log) [SPIKE-34] |
| Resume broke the prompt cache by re-rendering (attachments, MCP tool definitions, tool lists, memory age notes, hook output, pending prompts) | 2.1.275–2.1.290, each fixed separately | Prevented by design: stored epoch bytes are replayed, never re-rendered (one-way door #3) |

## Full changelog pass over researched features (2026-10-11)

The whole changelog (7,534 entries, 418 releases, 3,892 fixes) was sorted by feature (local cache: `research-cache/`, see its README). Every researched feature was re-read against its **complete** list, not keyword greps. Changes that came out of it:

| Feature | Changes from the complete history |
|---|---|
| Read | **Reverted** whole-file-over-limit to the first page + PARTIAL notice (Claude Code moved off the hard error in 2.1.145; the earlier change rested on a third-party blog). Plus: race-safe open by file identity; images refused if decoding fails; an image-bytes budget; pageable offload files; read-state rebuilt only from the resumed session's log |
| Edit | No regexes built from model text; 50 MB cap; quirk unescaping limited to `\n \t \r` |
| Write | Input aliases (`path`, `file_text`, numeric strings); new-file EOL from `.editorconfig` → `.gitattributes` → sibling files; umask; post-write verification (network and cloud folders); race-safe rename; read-only files refused; settings writes atomic and merged; rewind skips links; hooks refresh read-state (v0.2) |
| Grep/Glob | grep-style flags accepted; `.jj`/`.sl` excluded; fallback to system `rg`; "no matches" never returned for pagination past the end |
| Agent loop (partial) | Request-size guard before appending; strict tool-input JSON (the failure-cascade rule added here was superseded the same day, see F-06) |
| Bash | Script-file execution (no `-c`/`eval`; heredoc `${}` and 128 KB argument limits); `set +H`; escaped-process sweep by environment marker (SPIKE-35); changed-files list in results; `shell.path`, `shell.resetCwd`; temp files cleaned |
| PowerShell/Windows | **Binary-planting protection** (absolute executable resolution, `NoDefaultCurrentDirectoryInExePath`); UNC/device paths refused (NTLM leak); `PYTHONUTF8`; `2>nul` rewrite in Git Bash; PlainText rendering; native stderr isn't failure; benign exit list extended; Store `pwsh` aliases; cwd vanishing |
| Event log/resume | Stored epoch wins over changed settings; mode, taint and cost restored; self-heal by forking from the last valid point; U+2028/U+2029 escaped |
| Anthropic adapter | One shared retry budget; minimum 1 s backoff; damaged streams retried, never shown; continue after a drop from completed blocks; empty/thinking-only responses retried once; pre-output refusal retried once; HTML error pages summarized; 180 s first-byte timeout; server limits on the first request; effort-cache warning per model |

**Forwarded to later features** (Claude Code fixes that belong to specs not yet researched):
- F-08.4: `cmd /c rd|rmdir|del|erase` deleting drive roots and home from PowerShell (2.1.283).
- F-08.4: PowerShell parameters writing `$PSDefaultParameterValues` to redirect later file access (2.1.232).
- F-08.4: shell writes through a repo-committed symlink onto a sensitive file (2.1.287).
- F-08.4: writes through symlinked paths judged by their in-tree spelling (2.1.280).
- F-08.4: `for` loops over globs mis-parsed (2.1.295).
- F-08.4: `sandbox.excludedCommands` exempting a whole compound command (2.1.277).
- F-08.4: PowerShell permission checks skipped when the parser failed to start (2.1.285).
- F-06: a turn retrying forever while alternating unparseable tool calls and output-limit truncation (2.1.281).
- F-05/F-09: the first request after a model switch used built-in output limits instead of the server's (2.1.285, 2.1.288).
- F-08 (secrets): redaction misses: a key with no value, JSON inside a shell string, zero-width characters inside key names, URL passwords containing `)`, quotes, `]`, `&`, a second `@` or `%40` (2.1.285, 2.1.286, 2.1.296). Add all of them to the redaction test corpus.
- F-08.4: `rm -rf` on an 8.3 short name or other alternate spelling of home or a drive (2.1.292). Canonicalize with the long path name before critical-path checks.
- F-08.4: `pkill -f` patterns matching the agent's own process killed the session (2.1.214).
- F-08.4: prompt before writing `.zshenv`, `.zlogin`, `.bash_login`, `~/.config/git/` (2.1.160). Check against the protected-path list.
- F-06: mid-response API timeouts. Claude Code continues from the partial response in non-interactive sessions and retries thinking-only responses (2.1.288). Also a cache break after an auto-resumed max_tokens cutoff (2.1.269).
- F-05: an empty completed response requested twice after a drop before the final event (2.1.281); gateways returning non-streaming replies as `text/plain` (2.1.271); idle timeouts during long hidden thinking on Bedrock/Vertex, fixed with progress events and keep-alive pings (2.1.229, 2.1.257).
- F-12: terminal capability-query replies (`^[[?1;2c`, `22c`) typed into the prompt at startup over slow connections (2.1.269, 2.1.119). **Done:** [tui Terminal I/O robustness](../specs/tui.md).
- F-02: Windows installers reporting success after a failure (2.1.153); updates leaving the executable missing (2.1.217).
- v0.2 (F-14): memory cgroup limit for runaway builds (2.1.233); hooks/MCP returning non-text values causing 400s (2.1.286); skills discovered from gitignored `node_modules` (2.1.69).


## Inventory

| ID | Feature | Spec | Status |
|---|---|---|---|
| F-07.3 | Edit tool (matching, staleness, encoding) | [tools §3](../specs/tools.md) | ✅ researched 2026-10-11 |
| F-07.1 | Read tool (limits, line format, images, PDF, notebooks) | [tools §1](../specs/tools.md) | ✅ researched 2026-10-11 |
| F-07.2 | Write tool (and the write strategy shared by Edit/ApplyPatch/rewind) | [tools §2](../specs/tools.md) | ✅ researched 2026-10-11 |
| F-07.6 | Bash tool (shell snapshot, output limits, timeouts, cwd) | [tools §5](../specs/tools.md) | ✅ researched 2026-10-11 |
| F-07.7 | PowerShell tool / Windows shell selection | [tools §6](../specs/tools.md), [platforms](../specs/platforms.md) | ✅ researched 2026-10-11 |
| F-07.9 | Grep / Glob | [tools §7–8](../specs/tools.md) | ✅ researched 2026-10-11 |
| F-04 | Event log, crash safety, resume | [event-log](../specs/event-log.md) | ✅ researched 2026-10-11 |
| F-05.3 | Anthropic adapter (streaming, caching, thinking replay) | [providers §3](../specs/providers.md) | ✅ researched 2026-10-11 |
| F-06 | Agent loop (stop reasons, early tools, interrupts, queue) | [agent-loop](../specs/agent-loop.md) | ✅ researched 2026-10-11 |
| F-08.3 | Permission rules and modes | [permissions §1–3, §5–6](../specs/permissions.md), [cli-config](../specs/cli-config.md) | ✅ researched 2026-10-11 |
| F-08.4 | Shell command parsing and safety checks | [permissions §4](../specs/permissions.md) | ✅ researched 2026-10-11 |
| F-09.3 | Instruction files (AGENTS.md / CLAUDE.md) | [context §3–4](../specs/context.md) | ✅ researched 2026-10-11 |
| F-13 | Config, settings files, startup | [cli-config](../specs/cli-config.md), [platforms](../specs/platforms.md) | ✅ researched 2026-10-11 |
| F-08.7 | Sandbox (sandbox-runtime per OS) | [permissions §7](../specs/permissions.md) | ✅ researched 2026-10-11 |
| F-08.10 | Taint and prompt-injection defense | [permissions §10](../specs/permissions.md) | ✅ researched 2026-10-11 |
| F-07.11 | WebFetch | [tools §9](../specs/tools.md) | ✅ researched 2026-10-11 |
| F-07.12 | WebSearch | [tools §10](../specs/tools.md) | ✅ researched 2026-10-11 |
| F-11 | Checkpoints and rewind | [checkpoints](../specs/checkpoints.md) | ✅ researched 2026-10-11 |
| F-09.6 | Compaction | [context §5–6](../specs/context.md) | ✅ researched 2026-10-11 |
| F-10 | Budgets, cost, receipts, claim checker | [receipts-budgets](../specs/receipts-budgets.md) | ✅ researched 2026-10-11 |
| F-12 | TUI (rendering, input, permission prompt, keybindings) | [tui](../specs/tui.md) | ✅ researched 2026-10-11 |
| F-07.13 | Plan mode | [tools §11](../specs/tools.md) | ✅ researched 2026-10-11 |
| F-07.5 | AskUserQuestion / request_user_input | [tools §4](../specs/tools.md) | ✅ researched 2026-10-12 |
| F-05.4 | OpenAI Responses / Open Responses adapters | [providers §4](../specs/providers.md) | next |
| F-05.5 | Google Interactions adapter | [providers §5](../specs/providers.md) | |
| F-05.6 | Chat Completions fallback + local models | [providers §6](../specs/providers.md) | |
| F-05.7 | Retry and failover | [providers §7](../specs/providers.md) | |
| F-07.4 | ApplyPatch / native shell (gpt profile) | [tools §4](../specs/tools.md) | |
| F-02 | Distribution, install, self-update | [architecture](../specs/architecture.md), [cli-config](../specs/cli-config.md) | |
| F-14.x | v0.2 features (MCP, hooks, subagents, skills, LSP, ACP, background tasks) | [extensibility](../specs/extensibility.md) | after v0.1 specs |

---

## F-07.3 Edit tool

**Question:** strict exact matching (our earlier decision) or fuzzy fallbacks? Which scenarios break edits?

**Evidence:**
- **Tabs and CRLF are the most-reported Edit failures in Claude Code.** Models emit spaces for tab-indented files; multi-line matches fail on CRLF + tabs; Read output doesn't make tabs visible ([#26996](https://claudeissues.com/issue/26996-bug-edit-tool-silently-converts-tabs-to-spaces-causing-repeated-match-failures-o), [#28831](https://claudeissues.com/issue/28831-edit-tool-multi-line-old-string-matching-unreliable-on-crlf-files-with-tab-inden), [#54876](https://claudeissues.com/issue/54876-bug-edit-tool-fails-on-windows-with-crlf-line-endings-read-output-mismatches-fil)). Users' workaround is to fall back to Python/sed, which loses the reviewable diff.
- **Claude Code's quote normalization caused corruption:**
  - mixed quote styles in edited regions ([#23945](https://claudeissues.com/issue/23945-write-edit-tools-silently-convert-curly-quotes-u-2019-to-straight-quotes-u-0027));
  - broken C# string literals ([#38765](https://claudeissues.com/issue/38765-edit-tool-corrupts-non-ascii-unicode-characters-typographic-quotes-in-string-lit));
  - **the wrong occurrence edited**, because uniqueness was counted on raw text but the first normalized match was replaced ([#68962](https://claudeissues.com/issue/68962-bug-edit-tool-may-modify-the-wrong-occurrence-when-quote-normalized-matches-are)).
- **An independent benchmark** ran 4 CLI agents forked onto the same model, plus Claude Code ([Azam](https://charlesazam.com/blog/deepdive-benchmark/)).
  - Mistral Vibe scored highest (0.35). It applies edits **exactly** and uses fuzzy matching (≥ 90%) only to show a closest-match diff in the error.
  - OpenCode has nine fallbacks, including Levenshtein block anchors, and scored 0.21.
  - Codex has a 4-level cascade and scored 0.15.
  - Gemini CLI (retired since June 2026; historical data), at about 2,500 lines with an LLM fixer, scored 0.23.
  - Takeaways: more forgiveness ≠ better scores, and a format the model was trained on matters most.
- **Relative-indent matching** is the safe whitespace fallback: Zed requires a consistent leading-whitespace offset, and Pi's edit-o-matic dropped an earlier "flatten all indentation" mode after it corrupted Python ([Zed commit](https://git.secluded.site/zed/commit/1d33bfde371a5c75da08d93da5a8811cf6a5df58), [edit-o-matic](https://pi.dev/packages/edit-o-matic)).
- **Hash-anchored editing ("hashline")** beat patch editing for 14 of 16 models in Can Bölük's study, with the biggest gains on weak models (one went from 6.7% to 68.3%). The study author also built the tool, and models aren't trained on the format ([summary](https://claudeissues.com/issue/25775-feature-hash-based-line-addressing-for-the-edit-tool-hashline-approach)).
- **Gemini models double-escape** `\n`/`\t` in edit strings; Gemini CLI unescapes on every edit (Azam).

**Scenarios Glass must handle:**
1. Tab-indented file (Go, Makefile) with a space-indented `old_string`.
2. CRLF file.
3. `old_string` that includes Read's line-number prefixes.
4. Typographic quotes and other non-ASCII inside the edited region.
5. The same snippet appearing twice, only one of which matches loosely.
6. A formatter rewrote the file after the model read it.
7. Python indentation.
8. Double-escaped strings from Gemini.
9. A legacy-encoded file.
10. `replace_all` with loose matching.

**Decision** (spec: [tools §3.6](../specs/tools.md)):
- **Matching:** exact → line-prefix strip → consistent-offset indentation match. Each level must find exactly one match, counted at that same level. `replace_all` matches exactly only.
- **Not used to apply edits:** quote/dash normalization, Levenshtein matching and LLM fixers.
- **Errors:** fuzzy similarity appears only in the error, as a closest-match diff.
- **Unchanged lines keep their original bytes.**
- **Reporting:** a loose match is stated in the result and logged per edit, so evals measure it.
- **Gemini:** unescaping runs only behind a per-model quirk.

ACs added: AC-TOOLS-14..16. (Changelog: Claude Code's 2.1.47 fix for curly quotes reaches the same outcome as "unchanged lines keep original bytes"; no shipped fix for tab/space mismatches was found, so L2 stays.)

**Follow-ups:**
- Add a `default`-profile A/B of `Edit` vs hashline-style editing for weak and local models to the SPIKE-13 eval (v0.2 candidate). The `claude` and `gpt` profiles keep the formats their models were trained on (`str_replace`, `apply_patch`).

---

## F-07.1 Read tool

**Question:** are our limits, output format, re-read behavior and media handling right?

**Evidence:**
- **Line-number overhead.** A Claude Code user measured ~70% token overhead from padded line numbers ([#20223](https://github.com/anthropics/claude-code/issues/20223)). In v2.1.86 Claude Code switched to a "compact line-number format" and started deduplicating unchanged re-reads (changelog quoted in [#40123](https://claudeissues.com/issue/40123-docs-read-tool-docs-omit-compact-line-number-output-and-unchanged-re-read-dedupl)). Our spec still had the old padded format.
- **Claude Code's dedup is buggy.** It returns "unchanged" after edits from external editors ([#60684](https://claudeissues.com/issue/60684-bug-read-tool-returns-file-unchanged-after-external-on-disk-edits-serving-a-stal)), after `git checkout` ([#45748](https://claudeissues.com/issue/45748-bug-read-tool-returns-unchanged-since-last-read-after-git-checkout-changes-file)) and after rewind, when the content is no longer in context ([#68536](https://claudeissues.com/issue/68536-rewind-then-read-same-file-incorrectly-shows-unchanged-since-last-read)). Root cause: it compares against its own write-tracking state, not against what the model actually saw, and ignores whether that result is still in context.
- **Over-limit reads.** The 25k-token Read limit is hit at ~1,500 lines of code and can't be checked in advance ([#22506](https://github.com/anthropics/claude-code/issues/22506)). A Claude Code hook that blocks big whole-file reads and makes the agent locate first made answers cheaper with no quality loss, at about three extra tool calls per ten questions ([pugiunculus](https://github.com/namespaceMarcello/pugiunculus)). Sweep found that agents guess line ranges badly without a map ([Sweep](https://blog.sweep.dev/posts/read-file)). Roo Code gives explicit ranges priority over automatic truncation ([Roo](https://roocodeinc.github.io/Roo-Code/advanced-usage/available-tools/read-file/)).
- **Images** ([official docs](https://platform.claude.com/docs/en/build-with-claude/vision), verified):
  - cost is `⌈w/28⌉×⌈h/28⌉` visual tokens;
  - native long edge is 1,568 px (standard tier) or 2,576 px (Claude 4.7+);
  - **in a request with more than 20 images, counting history and tool results, any image over 2,000 px is rejected**;
  - caps: 10 MB base64 per image (5 MB on Bedrock/Vertex), 32 MB per request, 100 images per request for 200k-context models (600 otherwise);
  - animated GIFs use only the first frame.
- **PDFs** ([secondary](https://blog.jztan.com/llm-api-pdf-page-limits/), consistent across sources): 100 pages per request below 1M context, 600 otherwise; ~1,500–3,000 text tokens per page plus the page image.

**Scenarios:**
1. A 2,000-line file.
2. A 5 MB log.
3. A file edited by an IDE between two Reads.
4. Re-read after `git checkout`.
5. Re-read after compaction or rewind.
6. Edit, then re-read.
7. A FIFO or `/dev/stdin` (would hang).
8. `/proc` files (size 0).
9. A log growing while it's read.
10. 25 screenshots in one session.
11. A 4K screenshot on an older model.
12. A 40-page PDF on Windows without poppler.
13. Animated GIF.
14. A model without vision.

**Decision** (spec: [tools §1](../specs/tools.md)):
- **Output:** compact `<n>\t` format.
- **Over-limit reads:** a whole-file read over the limit returns only line count and size (no content); a range read over it returns a PARTIAL view.
- **Dedup:** only when the earlier result is still in the current epoch and branch **and** the current bytes hash-match what that Read returned; never twice in a row.
- **Special files:** regular files only, read with a bounded stream.
- **Images:** always ≤ 2,000 px (≤ the model's native edge), re-encoded to ≤ 500 KB, image count capped per model.
- **PDFs:** follow the token limit (≤ 8 pages whole), and use a pure-JS PDF library for ranges (SPIKE-6).
- **Context gauge:** the image token estimate in [context](../specs/context.md) uses the official formula.

ACs added: AC-TOOLS-17..20; AC-TOOLS-01 updated. The Read prompt is updated.

---

## F-07.2 Write tool (and the shared write strategy)

**Question:** is "temp file + rename" always right? What else goes wrong when an agent writes whole files?

**Evidence:**
- **Rename-based writes replace the inode, which breaks:**
  - **Docker single-file bind mounts:** the container keeps seeing the old file ([Claude Code #25438](https://claudeissues.com/issue/25438-bug-edit-write-tools-break-docker-bind-mounts-due-to-atomic-rename-inode-change); [Docker forum](https://forums.docker.com/t/sharing-a-single-file-via-a-volume-mount-does-not-work-as-expected/57088): "the bind-mount is still using the inode of the original file");
  - **hard links** ([#31290](https://claudeissues.com/issue/31290-bug-edit-tool-breaks-hard-links-creates-new-inode-instead-of-writing-in-place));
  - **group, setuid/setgid, xattrs** ([#60778](https://claudeissues.com/issue/60778-bug-bug-file-edits-cause-metadata-loss-group-setuid-xattrs-hardlinks));
  - **symlinks** replaced by regular files ([#40857](https://claudeissues.com/issue/40857-bug-symlinkdirectories-writing-to-symlinked-file-replaces-symlink-with-regular-f)).
  - The opposite choice also has a cost: in-place writes aren't atomic, and watchers can see a truncated file (a Next.js dev server reported "Unexpected eof").
- **Windows:**
  - `MoveFileEx` fails with access-denied when another process has the target open without share-delete, not only because of antivirus.
  - `ReplaceFileW` preserves ACLs and attributes ([Microsoft docs](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew); LLVM's fix tries ReplaceFileW first). The usual remedy is bounded retries with backoff ([LLVM review](https://reviews.llvm.org/D37398)).
  - Calling `ReplaceFileW` from Bun needs `bun:ffi`, which Bun's docs mark **experimental**.
- **Lazy placeholders:** models replace code with `// ... rest of the code ...` and destroy it; hooks and tools exist just to catch this ([claudekit spec](https://cdn.jsdelivr.net/npm/claudekit@0.9.5/specs/archive/feat-prevent-comment-replacement-hook.md)). Relace uses such markers *intentionally* with a merge model, so a marker is a bug only where no merge step exists, which is Glass's case.
- **Side finding** ([Bun docs](https://github.com/oven-sh/bun/blob/main/docs/runtime/code-generation-from-strings.mdx), via Context7): compiled Bun executables still honor `BUN_OPTIONS --preload` and `BUN_BE_BUN`.

**Scenarios:**
1. A file bind-mounted alone into a dev container.
2. A hard-linked config file.
3. A setgid shared-group file.
4. A file the IDE changed after the model read it (Write would silently erase the user's edit).
5. A Windows file open in another program.
6. Antivirus holding a fresh file.
7. A Vite/Next.js watcher reading during the write.
8. `// ... existing code ...` written over 200 lines.
9. A symlinked config.
10. A crash mid-write.

**Decision** (spec: [tools §2](../specs/tools.md)):
- **Write staleness is strict** (Edit stays relaxed, because an exact match proves context).
- **Placeholder guard:** refuse a new elision marker combined with ≥ 10 removed lines (also for Edit).
- **Write strategy:**
  - simple files: atomic rename (watchers never see partial files);
  - files whose identity matters (hard links, bind mounts, other owner, special bits): in-place writes, made safe because the checkpoint already holds the old bytes;
  - Windows: retries with backoff, then in-place.
- **Not used:** `ReplaceFileW` (no experimental FFI in v0.1).
- **Threat model:** documents `BUN_OPTIONS`/`BUN_BE_BUN`; Glass warns and strips them for child processes.

ACs added: AC-TOOLS-21..24; AC-TOOLS-05 updated. The Write prompt is updated. 15 and 11 now point to the shared strategy.

---

## F-07.6 Bash tool

**Question:** how should the user's shell environment be captured, how do commands end and get cleaned up, and which environment variables should be set?

**Evidence (mostly Claude Code bug reports):**
- **Shell snapshot (sourced script) failures:**
  - shell processes orphaned on every session start, including powerlevel10k's `gitstatusd` ([#24564](https://claudeissues.com/issue/24564-shell-snapshot-subprocesses-leaked-on-every-session-start-orphaned-zsh-bash-zomb));
  - oh-my-zsh functions causing a syntax error in the snapshot ([#1872](https://claudeissues.com/issue/1872-bug-claude-shell-snapshot-has-a-syntax-error-when-using-oh-my-zsh));
  - captured functions without their dependencies, breaking `cd` ([#9633](https://claudeissues.com/issue/9633-bug-shell-snapshots-capture-interactive-functions-without-dependencies-breaking), [#30683](https://claudeissues.com/issue/30683-bug-shell-snapshot-captures-compdef-function-but-not-comps-associative-array-bre));
  - `PATH` single-quoted so it never expanded ([#50181](https://claudeissues.com/issue/50181-bug-shell-snapshot-exports-path-with-single-quoted-path-preventing-expansion));
  - the app's minimal `PATH` replacing the shell's ([#43200](https://claudeissues.com/issue/43200-shell-snapshot-hardcodes-process-env-path-instead-of-capturing-shells-path)).
  - Users' workaround was forcing `SHELL=/bin/bash`.
- **Hangs:**
  - a dev server's children held output pipes, so the call never returned ([#20140](https://claudeissues.com/issue/20140-bug-claude-code-hangs-with-next-js-dev-server-run-in-background));
  - npm/npx commands hung indefinitely ([#27054](https://claudeissues.com/issue/27054-bug-npm-node-commands-npx-vite-build-npm-install-hang-indefinitely-in-the-bash-t), [#27401](https://claudeissues.com/issue/27401-bash-tool-hangs-when-piped-stdin-used-with-npx));
  - Git Bash piped commands never captured stdout ([#53143](https://claudeissues.com/issue/53143-bug-git-bash-on-windows-piped-commands-hang-stdout-never-captured)).
- **Windows Git Bash:**
  - dependence on `cygpath`, missing on some installs, broke Bash/Read/Write ([#7528](https://claudeissues.com/issue/7528-bug-critical-bug-claude-code-forces-non-existent-cygpath-on-windows-ignoring-ava), [#23487](https://claudeissues.com/issue/23487-bug-read-write-bash-tools-fail-with-command-failed-cygpath-u-on-windows));
  - a captured `PATH` mixing Windows and POSIX entries split on drive-letter colons ([#17134](https://claudeissues.com/issue/17134-bug-git-bash-path-format-mismatch-on-windows-prevents-command-execution));
  - turning `MSYS_NO_PATHCONV` on globally doesn't help and has side effects.
- **Environment variables:**
  - Codex reportedly injects `NO_COLOR=1`/`TERM=dumb`, which broke tests expecting colored output (a fork's commit note, unverified against Codex source);
  - Codex strips variables whose names contain KEY/SECRET/TOKEN by default ([guide](https://codex.danielvaughan.com/2026/04/28/codex-cli-shell-environment-policy-subprocess-secrets-defence/), secondary);
  - setting `CI` changes test behavior (Jest `--ci` refuses to write new snapshots; general knowledge, not from these sources).

**Scenarios:**
1. zsh + oh-my-zsh + powerlevel10k.
2. An rc that prompts for an update (`[Y/n]`).
3. conda/nvm/pyenv.
4. fish as the login shell.
5. A `PATH` with spaces or `$`.
6. `npm run dev &`.
7. `docker compose up` without `-d`.
8. `git merge` opening an editor.
9. Minified output on one line.
10. Binary output.
11. A test suite asserting colors.
12. macOS bash 3.2 or zsh glob errors.
13. Git Bash with Windows `PATH`.
14. `//flag` arguments on Git Bash.
15. A daemon escaping with `setsid`.

**Decision** (spec: [tools §5](../specs/tools.md), [platforms](../specs/platforms.md)):
- **Snapshot:**
  - environment variables only, captured as data (`env -0` → JSON) from the user's own shell, in the background at session start, with a 10 s limit;
  - the snapshot's process group is killed afterwards, with a clear fallback;
  - no aliases or functions, and no `PATH` capture on Git Bash.
- **Commands:**
  - each runs in its own process group;
  - completion is the shell's exit, not pipe EOF;
  - leftover background processes are killed and reported.
- **Environment:** adds `GIT_EDITOR=true` and `PYTHONUNBUFFERED=1`; deliberately does not set `CI`, `NO_COLOR` or `TERM=dumb`.
- **Output:** cuts very long lines, replaces binary runs, strips ANSI.
- **Prompt:** the shell and its version go in the system prompt.
- **Windows:** never calls `cygpath`; MSYS argument conversion stays on, with a per-command opt-out in the prompt.

ACs added: AC-TOOLS-25..27. Updated: the Bash prompt, the 04 `shell.snapshot` event, the 15 shell row and Git Bash paths, and PowerShell `envFile` (now `KEY=value` for all shells).

---

## F-07.7 PowerShell tool and Windows shell selection

**Question:** how should commands reach PowerShell safely and correctly on 5.1 and 7, and which Windows shell should be the default?

**Evidence:**
- **Claude Code's PowerShell tool** ([docs](https://code.claude.com/docs/en/tools), [overview](https://agentpatterns.ai/tools/claude/powershell-tool/)):
  - auto-detects `pwsh.exe`, falling back to `powershell.exe` 5.1;
  - doesn't load profiles;
  - is being rolled out as the Windows default, with Bash still registered;
  - has no Windows sandbox.
- **Claude Code bugs:**
  - `-EncodedCommand` was blocked by EDR as malware tradecraft ([#62348](https://claudeissues.com/issue/62348-bug-claude-code-encodedcommand-powershell-execution-blocked-by-edr-av-no-opt-out));
  - exit codes of `.ps1` scripts were lost under `-Command` without `exit $LASTEXITCODE` ([#24757](https://claudeissues.com/issue/24757-docs-windows-powershell-hooks-exit-code-from-ps1-scripts-not-propagated-to-claud));
  - a `$LASTEXITCODE` suffix triggered extra permission prompts ([#65974](https://claudeissues.com/issue/65974-bug-powershell-reporting-lastexitcode-causes-unnecessary-permission-checks));
  - output was garbled under the Big5 code page ([#46486](https://claudeissues.com/issue/46486-powershell-output-displays-garbled-text-on-windows-when-system-codepage-is-big5));
  - every command failed with exit 1 and no output in one spawn setup ([#94196](https://claudeissues.com/issue/94196-bash-powershell-tool-fails-instantly-on-windows-exit-code-1-zero-stdout-stderr-e)).
- **PowerShell 5.1 vs 7** ([Microsoft about_Character_Encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_Character_Encoding), community reports):
  - `>` is `Out-File`, which writes UTF-16LE in 5.1 and UTF-8 without BOM in 7;
  - `-Encoding UTF8` adds a BOM in 5.1;
  - 5.1 strips embedded double quotes from arguments to native programs ([report](https://dev.to/onurkizildag/i-spent-4-hours-fighting-powershell-51-quoting-hell-to-make-exa-mcp-work-here-is-the-10-line-fix-2jf3));
  - 7.3+ changed native argument passing again ([PowerShell #18664](https://github.com/PowerShell/PowerShell/issues/18664));
  - reports conflict on whether `$PSDefaultParameterValues` affects `>` in 5.1.

**Scenarios:**
1. An EDR-protected corporate laptop.
2. A Group Policy `AllSigned` execution policy.
3. Constrained Language Mode.
4. Only Windows PowerShell 5.1 installed.
5. A model writing `&&` or `curl -X POST` on 5.1.
6. `echo x > file.txt` on 5.1 (produces UTF-16).
7. JSON arguments to a native tool.
8. Non-ASCII output under a CJK code page.
9. A native program failing with exit 3.
10. A cmdlet error.
11. `cd` carry-over.
12. Slow startup per command.

**Decision** (spec: [tools §6](../specs/tools.md)):
- **Passing the command:** never `-EncodedCommand`. Glass writes a UTF-8-with-BOM `.ps1` and runs it with `-ExecutionPolicy Bypass -File` (process scope only), falling back to `-Command` when Group Policy enforces a policy.
- **Wrapper:**
  - silences progress output;
  - forces UTF-8 encodings (each assignment guarded for Constrained Language Mode);
  - sets `Out-File` UTF-8 on 5.1;
  - captures cwd in `finally`;
  - computes the exit code from `$LASTEXITCODE` and `$?`, and is never shown to the permission parser.
- **Prompts:** a separate 5.1 tool description lists its traps.
- **Default shell:** Git Bash stays first on Windows until a new eval spike, SPIKE-32, compares Bash, PowerShell and both.
- **Spikes:** SPIKE-14 widened to cover redirect encoding, `finally` on `exit`, startup time, CLM and GPO policies.

AC added: AC-TOOLS-28. New prompt files `PowerShell51.md` and `BashGitBash.md`; prompt README updated.

---

## F-07.9 Grep and Glob

**Question:** should Glob respect `.gitignore` (we had copied Claude Code's "no")? Are there other ripgrep or glob traps?

**Evidence:**
- **Claude Code's Glob passes `--no-ignore --hidden --sort=modified`, which caused:**
  - silent "No files found" when a large ignored directory pushed it past its timeout ([#16043](https://claudeissues.com/issue/16043-bug-glob-silently-fails-when-large-gitignored-directories-cause-ripgrep-timeout));
  - 20 s timeouts in monorepos where `rg` honoring `.gitignore` takes 0.5 s ([#22379](https://claudeissues.com/issue/22379-bug-glob-tool-times-out-20s-while-equivalent-ripgrep-command-completes-in-1s));
  - `node_modules` noise for `**/*.md` ([#20609](https://claudeissues.com/issue/20609-bug-glob-tool-doesnt-respect-gitignore));
  - a walk that can't be pruned and runs single-threaded, because `--sort modified` disables ripgrep's parallelism ([#77488](https://claudeissues.com/issue/77488-bug-glob-tool-hardcodes-no-ignore-hidden-sort-modified-un-prunable-single-thread)).
- **ripgrep ignores `.gitignore` without a `.git` directory** unless given `--no-require-git` ([ripgrep 12.0.0](https://redirect.github.com/BurntSushi/ripgrep/releases/tag/12.0.0)). This flooded Claude Code's Grep in Mercurial repos ([#9411](https://claudeissues.com/issue/9411-claude-codes-grep-tool-should-use-no-require-git-for-non-git-repos-that-still-us)).
- **Claude Code v2.1.117 replaced Grep/Glob with embedded bfs/ugrep through Bash** on native macOS/Linux, citing speed. Afterwards:
  - the model's guidance still named the removed tools ([#69849](https://claudeissues.com/issue/69849-bug-native-macos-linux-builds-v2-1-117-removed-glob-grep-tools-but-model-guidanc));
  - the binaries weren't reachable from Bash ([#52476](https://claudeissues.com/issue/52476-bug-embedded-bfs-ugrep-not-exposed-in-bash-tool-native-macos-build-2-1-117));
  - third-party hooks broke.
- **ripgrep's `--glob` uses gitignore semantics** (a slash-free pattern matches at any depth), unlike the standard glob semantics models expect (`*.ts` = top level).

**Scenarios:**
1. A monorepo with large `node_modules`.
2. A 100 GB ignored `tmp/`.
3. A Mercurial, jj or unzipped project with a `.gitignore`.
4. Searching inside `node_modules/pkg` on purpose.
5. A file that exists only in an ignored build directory.
6. `*.TS` on macOS.
7. `*.ts` vs `**/*.ts`.
8. Very slow network drives (WSL `/mnt/c`).
9. `.env` contents leaking into Grep results.
10. Long absolute paths repeated thousands of times.

**Decision** (spec: [tools §7–8](../specs/tools.md)):
- **Ignore files:** both tools respect them, also outside git (`--no-require-git`). An ignored `path` is searched explicitly. Glob falls back to ignored files when nothing else matches, and marks them. (This is a deliberate divergence from Claude Code, with its setting kept.)
- **Glob semantics:** standard, anchored at `path` (`Bun.Glob`), not ripgrep's.
- **Sorting:** Glass stats and sorts in parallel itself.
- **Case:** a case-insensitive retry on case-insensitive filesystems.
- **Timeouts:** a 20 s limit with partial results, never a silent empty answer.
- **Output:** cwd-relative paths and grouped content output.
- **Tools kept:** Grep/Glob stay as tools (SPIKE-13 still decides for the `claude` profile). Claude Code's removal shows the cost of dropping them: stale guidance and broken hooks.

ACs added: AC-TOOLS-29..30. Grep and Glob prompts updated; settings default noted in 21.

---

## F-04 Event log, crash safety, resume

**Question:** what breaks session storage in practice: stuck sessions, slow resume, disk bloat? Is "JSONL, no database" still right?

**Evidence:**
- **Claude Code sessions became permanently unresumable:**
  - every request failed with 400 after an interruption left a tool call without its result ([#9346](https://claudeissues.com/issue/9346-bug-tool-result-tracking-error-after-session-interruption-causing-repeated-api-4));
  - saved empty text blocks between tool calls caused 400s ([#62396](https://claudeissues.com/issue/62396-api-error-400-messages-text-content-blocks-must-be-non-empty-on-session-resume-w));
  - empty thinking blocks caused 500s ([#58827](https://claudeissues.com/issue/58827-resuming-old-sessions-returns-api-error-500-status-code-no-body-caused-by-empty));
  - resume/fork failed on sessions containing tool calls ([#41729](https://claudeissues.com/issue/41729-resume-forksession-fails-with-400-on-sessions-containing-tool-use-blocks)).
  - Users' only remedies were hand-editing the JSONL or abandoning the session.
- **Disk:**
  - Claude Code has age-based cleanup only (30 days), no size cap and no disk warning ([guide](https://bestagent.dev/claude-code-disk-usage-cleanup));
  - Codex session logs reached 0.7–2 GB each from repeated compaction history and raw tool output ([openai/codex#24948](https://upd.dev/openai/codex/issues/24948)), and one resumed thread produced 731 GiB of child logs ([analysis](https://braindetox.kr/en/posts/codex_cli_disk_bloat_2026.html)).
- **Resume speed:** Codex loaded the whole rollout into memory, with resumes up to ~82 s, and an auto-resumed oversized session froze every launch ([#25779](https://upd.dev/openai/codex/issues/25779)). Codex later added SQLite-backed paginated history ([secondary](https://codex.danielvaughan.com/2026/07/23/codex-cli-paginated-thread-history-sqlite-session-resume-search-memories/)).
- **OpenCode** moved from per-object JSON files to one SQLite database in WAL mode. Its one-time migrator was later removed, and external tools reading the old paths broke silently ([summary](https://github.com/microsoft/AI-Engineering-Coach/issues/84)).

**Scenarios:**
1. Kill -9 during a tool run.
2. Kill -9 during a permission prompt.
3. Provider rejects the replayed history after an API change.
4. A 500 MB session resumed.
5. A session with many huge command outputs.
6. Months of daily use filling the disk.
7. A CI run that shouldn't leave transcripts.
8. A user who wants to search all sessions (v0.2).

**Decision** (spec: [event-log Resume, Disk use](../specs/event-log.md), [context](../specs/context.md), [tui](../specs/tui.md), [cli-config](../specs/cli-config.md), [interfaces](../specs/interfaces.md)):
- **Crash recovery** appends results for unfinished tools and permissions plus `turn.end: crashed`.
- **No empty blocks:** Glass never writes empty or padding blocks; a pre-request validator asserts it.
- **Repair epoch:** a history-rejection by the provider offers one (headless exit code 6 + `--repair`), so no session is ever stuck and the log is never edited.
- **Resume:** streams line by line from the latest epoch via a sidecar offset, with no auto-resume.
- **Disk:**
  - offload outputs expire after 7 days;
  - the data-directory size shows in `/status`, with a warning above 10 GB;
  - sessions can be pruned by size.
- **Ephemeral sessions:** `--no-session-persistence`.
- **No database (ADR-4) stays, and it is Claude Code's design.** Claude Code has always stored sessions as append-only JSONL with no database, and that format has held up at its scale. Its storage bugs above came from *what* it wrote (empty blocks, missing results) and from missing size controls, not from JSONL itself. That is why Glass fixes content and disk use, not the format. JSONL also gives append-only crash tolerance (at worst one partial last line), human-readable logs, no schema migrations and no native dependency.
- OpenCode and Codex added SQLite to query many sessions and to paginate one huge file. Glass avoids the huge-file problem with epochs, the sidecar offset and output caps. Cross-session search is v0.2. The revisit trigger in 04 (listing > 200 ms) remains, and any future index must be a disposable cache rebuilt from the JSONL.

ACs added: AC-LOG-11..14. New settings `retention.outputsDays` and `retention.warnAtGB`; new flags `--repair` and `--no-session-persistence`; exit code 6; epoch reason `repair`.

---

## F-05.3 Anthropic adapter

**Question:** are our caching, error and replay rules exactly right against the current official docs? What breaks caching in practice? (One-way doors #3 and #4.)

**Evidence:**
- **Official prompt-caching docs** ([platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), verified 2026-10-11):
  - **Breakpoints:** automatic top-level `cache_control` uses one of 4 breakpoint slots; the lookback is 20 positions (consecutive `tool_use`/`tool_result` blocks count as one).
  - **Minimum size:** 512 tokens on current models.
  - **TTL is measured from the start of the request.** 1 h writes cost 2×, 5 m writes 1.25×; reads cost 0.1× (0.05× Opus/Sonnet 5.5, 0.025× Fable 5.1).
  - **Invalidation:** effort and thinking changes invalidate message caches; adding or removing images affects message blocks.
  - **Concurrency:** an entry is readable only after the first response begins.
  - **New:** the `inline-tools-2026-09-15` beta adds tools mid-conversation without invalidating the cache.
- **Caching failures in the field:**
  - Claude Code resume caused a prefix mismatch that rewrote the whole history every turn (#40524, [secondary](https://pasqualepillitteri.it/en/news/596/claude-code-cache-bug-token-10-20x));
  - a reverse-engineered Claude Code binary reportedly rewrote request bodies after render ([secondary](https://smartscope.blog/en/blog/claude-code-token-consumption-cache-bug/), unverified);
  - **LiteLLM 1.91.0–1.91.1 moved system-role messages into `system`, silently breaking Claude Code caching through Bedrock** ([LiteLLM incident](https://docs.litellm.ai/blog/bedrock-invoke-prompt-caching-incident)).
- **Keep-alive:** no source documents `max_tokens: 0`; cache warmers use `max_tokens` 1–8 ([examples](https://notes.dsebastien.net/30+Areas/33+Permanent+notes/33.02+Content/Pre-warm+the+Prompt+Cache)).
- **Mid-stream errors:** after the stream starts, overloads arrive as an SSE `error` event inside an HTTP 200 response, with no `message_stop`. Status-code-only retry logic misses them ([write-up](https://blogs.novita.ai/llm-api-streaming-error-troubleshooting/), [Kindo docs](https://docs.kindo.ai/apis/messages/streaming/)).

**Scenarios:**
1. A 6-minute test run between two requests in a turn.
2. The user away for 20 minutes.
3. Resume after a Glass upgrade.
4. A gateway rewriting system messages.
5. An `/effort` change mid-session.
6. Overload mid-stream after 2 text blocks.
7. Many images in history.
8. Cost on Opus 5.5 vs Sonnet 5 (different read multipliers).
9. v0.2 MCP tools added mid-conversation.

**Decision** (spec: [providers §3](../specs/providers.md), [event-log](../specs/event-log.md), [tui](../specs/tui.md), [cli-config](../specs/cli-config.md), [extensibility](../specs/extensibility.md), [interfaces](../specs/interfaces.md)):
- **TTL:** `cache.ttl: auto` puts 1 h on the stable system breakpoint and 5 m on the tail (SPIKE-33 measures it).
- **Keep-alive:** uses `max_tokens: 1` and is never appended to the transcript.
- **Request bytes:** a rule that rendered bytes are never mutated, enforced by a transport hash check.
- **Cache diagnosis:** a prefix fingerprint in every `model.request`; `/why --cache` names the first changed block and flags gateways as suspects.
- **Mid-stream errors:** an in-stream `error` event is handled like an HTTP error.
- **Prices:** per-model cache-read prices.
- **v0.2:** `inline-tools` beta noted for deferred MCP tools.

**Confirmed unchanged:**
- **Mid-epoch system messages:** sent as a `role: system` message, falling back to a text block.
- **Thinking replay:** `prefix_mismatch_behavior: "error"`.
- **Request controls:** `tool_choice` stays auto; no sampling parameters; no prefill.
- **Retries:** SDK retries off.

ACs added: AC-PROV-11..13. New SPIKE-33.

---

## F-06 Agent loop

**Source:** the complete Claude Code changelog list for the loop (`research-cache/cc-changelog/F-06.txt`, 219 entries, 157 fixes), plus the forwarded items.

**Rule learned the hard way:** a behavior that changed over time is decided by its **latest** entry. Failure cascades changed three times:
- all errors cancelled siblings until 2.1.47;
- only Bash errors from 2.1.72;
- none from 2.1.161.

The previous pass had adopted the middle version. Glass now matches 2.1.161.

**Lessons applied** (spec: [agent-loop](../specs/agent-loop.md), [event-log](../specs/event-log.md)):
- **No failure cascade** among parallel calls (2.1.161).
- **Permission prompts:** pending prompts are re-evaluated after each answer (2.0.22); an unknown tool name gets an error result without blocking the batch (2.1.126).
- **Interrupt before any output:** the turn ends `cancelled`, its message is excluded by rule (nothing rewritten) and returned to the input box (2.1.73/2.1.83); interrupts at the first instant are honored (2.1.162).
- **Queued input:**
  - Esc moves queued messages back to the input (2.1.239 race);
  - queued messages survive every kind of turn end (2.1.205), with their attachments (2.1.105, 2.1.221);
  - an `end_turn` with a queue starts the next turn at once (1.0.84);
  - queueing never interrupts thinking (2.1.33).
- **New guards:**
  - malformed or truncated rounds (2.1.281);
  - never re-sending a request that got a non-retryable error (2.1.218);
  - compaction thrash (2.1.89).
- **SIGTERM/SIGHUP** write no synthetic results; resume's crash recovery is the single path (2.1.236), and its wording never blames the user (2.1.296).
- **Already covered by earlier passes:**
  - continue after a mid-response drop (2.1.288);
  - empty or thinking-only responses (2.1.251);
  - pre-output refusal retry (2.1.290);
  - damaged-stream retry (2.1.284);
  - interrupted results never reported as "completed" (2.1.246);
  - unpaired `tool_use` prevented by the pairing invariant (2.1.218).

**Not adopted (Claude Code-specific or v0.2):**
- `/loop` and scheduled tasks (many fixes; no equivalent in v0.1);
- background agents and sessions;
- Stop-hook block caps (8, 2.1.143) and subagent spawn caps (200, 2.1.212), recorded for the v0.2 hooks and subagents specs.

ACs added: three new 06 criteria.

---

## F-08.3 Permission rules, modes and prompts

**Source:** `research-cache/cc-changelog/F-08.txt` (635 entries, 362 fixes). The entries about shell-command *analysis* (about 45) are left for F-08.4. Excluded from this pass: auto mode and the classifier (v0.2), managed or remote settings, IDE, worktrees, background agents.

**Lessons applied** (spec: [permissions §1–3, §5–6](../specs/permissions.md), [cli-config Live settings reload](../specs/cli-config.md), [platforms](../specs/platforms.md), [interfaces](../specs/interfaces.md)):
- **Rule loading:**
  - text after `)` is an error (2.1.260);
  - NUL rules match nothing (2.1.281);
  - an uncompilable deny guards its literal path (2.1.260);
  - `Map`-based storage, so `toString` can't disable a file (2.1.97);
  - compiled matchers are cached (2.1.208);
  - unreachable-rule warnings (2.1.3).
- **Matching:**
  - `:*` anywhere ≡ ` *` (2.1.282);
  - match on re-joined argv, so whitespace and quoted `#` can't defeat rules (2.1.76, 2.1.98);
  - redirections excluded from the match and path-checked separately (1.0.123);
  - deny rules see through exec wrappers (2.1.113);
  - rules match the requested or canonical path, with rule paths canonicalized too (2.1.89, 2.1.268);
  - Windows backslash, drive-letter and drive-root rules (2.1.111, 2.1.133, 2.1.162);
  - explicit WebFetch rules override pre-approved domains (2.1.162).
- **Modes:**
  - `manual` alias (2.1.200);
  - no silent mode changes (2.1.97);
  - leaving plan returns to the previous mode (2.1.105);
  - plan mode beats allow rules for mutations (2.1.136, 2.1.212);
  - read-only tools allowed when starting in plan mode (2.1.198);
  - a mode switch re-evaluates an open prompt (2.1.141);
  - **protected-path writes prompt even in bypass mode** (2.1.78; a revision of our earlier rule).
- **Prompts:**
  - plain-language reasons (2.1.287);
  - invisible and bidi characters shown, which withholds "don't ask again" (2.1.211);
  - masking never hides commands or paths (2.1.234);
  - "don't ask again" only when everything is displayable and the rule round-trips (2.1.47, 2.1.72, 2.1.77, 2.1.235);
  - oldest prompt first with a counter (2.1.286, 2.1.287);
  - focus clicks never answer a prompt (2.1.239);
  - Enter and keystroke routing (2.1.141, 2.1.72, 2.1.235);
  - `/permissions` usable mid-turn (2.1.234), with a Recently denied tab (2.1.191).
- **Saving:** `settings.local.json` is created if missing (2.1.252) and excluded through `.git/info/exclude`; session grants are never saved (2.0.30).
- **New spec section, Live settings reload:**
  - watches files and their parent directories, and symlink targets;
  - applies policy at once;
  - announces model/tool changes instead of applying them;
  - keeps the last valid settings on errors;
  - `--add-dir` survives settings edits (2.1.41, 2.1.97, 2.1.139, 2.1.257).
- **Internal git calls:** `GIT_TRACE*` unset for Glass's own git calls (2.1.285).

**Candidate for v0.2:** a `--restricted` mode for reviewing untrusted repositories: no shell or code tools and no WebFetch, file tools confined to the working directory, bypass refused (Claude Code 2.1.248).

**Handed to F-08.4 (shell analysis):** all F-08 entries about command parsing:
- variables: `BASH_ARGV0`, `BASHPID` arithmetic, special and integer variables, zsh `REPORTTIME` and similar, `declare`/`typeset`/`export` prefixes;
- glob and wildcard expansion in read-only commands' arguments and options;
- `for` loops over globs;
- zsh-vs-bash differences in `[[ ]]`;
- `rm` hidden in `bash -c`, behind redirects or in `"$(pwd)"`;
- `$HOME` references;
- `tee`, `< file` and option-value file operands;
- unanalyzable lines (`eval`, `env -C`) prompting rather than denying (2.1.273 revert);
- `cd` no-op and `/dev/null` cases;
- read-only list changes (`pyright`, `ps`, `file -m`, `help`/`man`);
- backslash-escaped flags;
- line continuations;
- PowerShell `cd` variants and drive switches, `cmd /c rd`, `$PSDefaultParameterValues`, trailing `&`, parse-failure fallback;
- Git Bash `/c/Users` critical paths and 8.3 names.

ACs added: five new 08 criteria.

---

## F-08.4 Shell command analysis and safety checks

**Source:** every shell-analysis entry in F-08, F-07.6 and F-07.7 (about 150 entries), plus the items forwarded from earlier passes.

**What the history shows:** about 50 entries are *permission-check bypasses*, each closing one shell trick:
- special and integer variables;
- zsh-only syntax;
- declaration flags;
- escaped flags;
- fd-redirect forms;
- wrappers;
- hidden `rm`;
- option-value files;
- cwd tracking;
- PowerShell `cd` variants and variable-writing parameters.

Patching tricks one at a time is a treadmill. The *solution* behind the fixes is two principles. Glass adopts both and keeps the individual cases as tests.

**Decision** (spec: [permissions §4.0–4.6](../specs/permissions.md), [tools §5.3](../specs/tools.md), [platforms](../specs/platforms.md), [testing](../specs/testing.md)):
1. **Auto-approve only fully understood commands.** An allowlist of syntax constructs; anything else is "not fully checkable" → ask. Deny and critical checks still apply to the readable parts. Unknown means a prompt, not a denial (2.1.273's revert).
2. **Execute the shell that is analyzed:** model commands always run in **bash** (a revision; previously the user's zsh). Glass replays no functions or aliases, so zsh gave nothing and cost soundness.
3. **Read-only commands as data:** accepted options plus file-taking options; an unknown option is not read-only.
4. **Every file operand is checked:** literals, globs Glass expands itself, and option values. Globs in pattern positions → ask.
5. **cwd simulation** through `cd`/`pushd`/`popd`.
6. **One finding flags the whole command.**
7. **Fail closed** on parser failure or a 200 ms budget overrun.
8. **10,000-character limit** for every shell.
9. **Critical paths, in every spelling:** `$HOME` with a trailing slash, Git Bash `/c/Users`, 8.3 names, macOS `/private/*`. Sandbox auto-allow never skips the check.
10. **Self-protection:** `kill` of Glass itself is denied; `pkill`/`killall` patterns that could match Glass → ask. Shell writes to files Glass's tools refuse → ask, even under a `Bash` allow rule.
11. **Prefix rules never cover** docker/podman daemon redirects, or `git`/`gh` `--force`/`--no-verify`/`--amend`.
12. **PowerShell specifics:**
    - `cd` variants and drive switches;
    - preference and variable-writing parameters;
    - trailing `&`, `-ErrorAction Break`, archive extraction;
    - quoted paths;
    - `--` vs `--%`.
13. **Read-only list updated** from 2.1.71, 2.1.72, 2.1.214 and 2.1.290.
14. **`TMPDIR`** reset when a command is retried outside the sandbox.

**Test corpora (the lasting benefit):** two data files, kept as regression tests on every PR:
- every Claude Code bypass shape (must never auto-approve);
- every false-prompt fix (must not prompt).

The Claude Code fix version is recorded per case.

ACs added: three new 08 criteria.

---

## F-09.3 Instruction files

**Source:** 70 instruction-file and memory entries across the changelog.

**Lessons applied** (spec: [context §3–4](../specs/context.md), [interfaces](../specs/interfaces.md)):
- **Exactly-once loading** by canonical identity, across every route. Five separate Claude Code duplicate-load bugs:
  - resume and compaction (2.1.287);
  - repeated nested injection (2.1.89);
  - `--add-dir` (2.1.281);
  - nested worktrees (2.1.69);
  - drive-letter case (2.1.47).
- **Trust made explicit:** instructions load regardless of folder trust (content, not capability).
- **Policy applies to instruction loading:**
  - Read deny and outside-directory blocks on canonical paths (2.1.290);
  - symlinks out of the project count as external imports (2.1.284);
  - network paths are never read (2.1.282).
- **Lazy-load triggers:** writes and creates (2.1.288), shell views (2.1.293), `@` mentions (2.1.290); canonical-path matching for `paths:` (2.1.198).
- **Bounded `paths:` brace expansion** (2.1.217).
- **Import grammar:** imports outside code spans and blocks, consecutive `@~/` imports (2.0.67), no binary imports (2.1.2).
- **Size warnings** count all files together and scale with the context window (2.1.169, 2.1.281).
- **New settings:** `instructions.exclude` (2.1.239) and `instructions.fromAdditionalDirectories` (2.1.20).
- **`/rules` shows unloaded files with reasons** (2.1.292).
- **Reserved harness markers are escaped** in all content Glass didn't author; invisible characters shown (2.1.284, 2.1.292).
- **Auto-memory lessons recorded for v0.2:**
  - explicit truncation errors (2.1.210, 2.1.268);
  - timestamps computed at write time (2.1.75, 2.1.275);
  - `#` in frontmatter (2.1.214).

**Deliberate divergence kept:** Glass loads both AGENTS.md and CLAUDE.md; Claude Code reads AGENTS.md only without a CLAUDE.md (2.1.277).

**v0.2 ideas noted:** a `/doctor` audit of instruction files for stale paths, contradictions and derivable content (2.1.206, 2.1.283).

ACs added: three new 09 criteria.

---

## F-13 Config, settings files and startup

**Source:** `F-13.txt` (792 entries). About 170 were relevant after excluding UI preferences, managed/enterprise settings, remote/cloud and auth flows Glass doesn't have.

**Lessons applied** (spec: [cli-config](../specs/cli-config.md), [platforms](../specs/platforms.md), [interfaces](../specs/interfaces.md)):
- **Invalid values by kind:** policy keys fail startup; other keys are dropped with a warning (2.1.121).
- **Safe settings reads:** regular files only, 2 MiB cap (2.1.214, 2.1.280); strict numbers (2.1.208, 2.1.101); `retention.days ≥ 1` (2.1.89).
- **New `env` setting:**
  - subprocesses only (2.1.143);
  - launch environment wins, with ignored keys listed (2.1.281);
  - project scope only in trusted folders, with dangerous names refused;
  - no cross-project effects (2.1.105).
- **CLI flags are session overrides** that settings writes can't reset (2.1.72).
- **State files** are backed up and rebuilt when corrupt, and written under a lock (2.1.61, 2.1.181, 2.1.199).
- **Startup:**
  - no network on the critical path; the update check is delayed (2.1.144, 2.1.181, 2.1.222, 2.1.238);
  - starts with an unwritable config/data directory (2.1.162);
  - write failures are visible (2.1.217);
  - inherited Glass variables are ignored (2.1.170).
- **Live reload uses `stat` polling** at turn and batch boundaries instead of OS watchers (2.1.271).
- **Glass's own git calls:**
  - plumbing only, no filters (2.1.265);
  - `GIT_NO_LAZY_FETCH` in partial clones (2.1.84);
  - no credential prompts (2.1.169).
- **`glass project purge`** (2.1.126).
- **Fixed internal contradiction:** startup said the shell snapshot runs lazily, while 07 starts it at session start.

**Forwarded:** F-12 (TUI): terminal capability replies leaking into the prompt at startup over slow links (2.1.269, 2.1.119).

ACs added: four new 13 criteria.

---

## F-08.7 Sandbox

**Source:** `F-08.7.txt` (129 entries). Managed and enterprise sandbox controls are excluded.

**Refinement of F-08.4:** under sandbox auto-allow, "not fully checkable" is the wrong bar. Claude Code removed prompts for sandboxed commands with expansions, inline scripts, heredocs to interpreters and env-prefixed interpreters (2.1.139, 2.1.285, 2.1.288, 2.1.290, 2.1.292). Glass now requires only literal command-name positions for sandboxed auto-allow, so deny rules and critical checks stay decidable. Dynamic command names still ask.

**Lessons applied** (spec: [permissions §4.0, §7](../specs/permissions.md), [cli-config](../specs/cli-config.md)):
- **excludedCommands:**
  - all parts must match (2.1.277);
  - argv-based matching with option-spelling equivalence (2.1.72, 2.1.281, 2.1.290);
  - project entries only when trusted and not strict (2.1.282).
- **Path normalization:** trailing slashes (2.1.224), absolute paths (2.1.78), parentheses (2.1.260).
- **Glob expansion budget** for sandbox rules (2.1.179, 2.1.290).
- **Host spellings:** trailing dots in deny lists (2.1.257), bracketed IPv6, ambiguous spellings rejected (2.1.229).
- **Anchored protected entries** (2.1.275).
- **Linked worktrees:** writes to common-dir internals only (2.1.149, 2.1.257).
- **Symlinked protected files:** deny both link and target; never block startup; never deleted by cleanup (2.1.176, 2.1.178, 2.1.210, 2.1.247).
- **No workspace traces:** no stubs, locks or unreadable placeholders (2.1.69, 2.1.78, 2.1.239, 2.1.271).
- **TMPDIR:** created per command; sandboxed only; one per session (2.1.45, 2.1.101, 2.1.154, 2.1.163).
- **Close-on-exec** for everything (2.1.287).
- **Non-blocking bring-up** (2.1.243).
- **Violations reported even on exit 0** (2.1.224, 2.1.243), with fix hints (2.1.267, 2.1.281).
- **Honest tool description:** no host list; strength matches the actual state (2.1.243, 2.1.268).

**Confirmed already in the spec:**
- missing dependencies are visible, never a silent disable (2.1.78);
- `failIfUnavailable` (2.1.83);
- the unsandboxed retry prompts (2.1.113);
- critical paths are never skipped by auto-allow (2.1.116);
- `strictAllowlist` (2.1.219);
- `!` runs outside the sandbox (2.1.260);
- network "Yes" is remembered for the session (2.1.191).

**v0.2 candidates:**
- credential masking through the proxy: sentinel files and values, JWT/AWS-aware (2.1.221, 2.1.224);
- `filesystem.disabled` with network control kept (2.1.216);
- a Linux memory cgroup per command (2.1.233).

ACs added: three new 08 criteria.

---

## F-08.10 Taint and prompt-injection defense

**Sources:**
- Claude Code's changelog, about 30 relevant entries. Its injection defense is a classifier plus server-side checks, so there are few direct analogues.
- [Willison / Meta "Agents Rule of Two"](https://simonw.substack.com/p/new-prompt-injection-papers-agents) and the ["lethal trifecta"](https://www.sophos.com/blog/inside-the-lethal-trifecta-blast-radius-reduction-in-ai-agent-deployments).
- [CSA research note on Unicode instruction injection in agent skills (Mar 2026)](https://labs.cloudsecurityalliance.org/research/csa-research-note-unicode-instruction-injection-ai-skills-20/): a Feb 2026 demonstration that Claude Code, Copilot, Codex and Gemini CLI executed hidden tag-character instructions. The note is AI-assisted and not officially reviewed.
- [ASCII smuggling overview](https://promptfoo.dev/docs/red-team/plugins/ascii-smuggling/); the 2025 rules-file backdoor ([summary](https://futureagi.com/glossary/ascii-smuggling-injection-attack)).

**Decision** (spec: [permissions §10](../specs/permissions.md), [tools §1](../specs/tools.md), system prompt):
- **Rule of Two mapping documented.** The defaults already remove leg B (credentials) and limit leg C (registry-only network). Taint further restricts B and C once stronger untrusted input arrives.
- **New taint triggers:**
  - WebSearch, which was already in 07 but missing from 08;
  - sandboxed traffic to non-registry hosts (from the proxy log);
  - hidden-instruction characters;
  - (v0.2) tainted subagents.
- **While tainted:** sensitive-file reads get a banner and no "don't ask again"; `gh` create/comment commands join the denied exfiltration list.
- **Hidden characters:**
  - tag characters and the variation-selector supplement are removed from the model's view, with a marker, a note and taint;
  - ZWJ/ZWNJ and VS16 are untouched (2.1.280);
  - bidi controls are visible to humans only (they target human readers).
- **Forged authority:**
  - "no user input occurred" wording in harness notices (2.1.205);
  - a system-prompt line saying approvals come only through the permission system;
  - marker escaping, from F-09.3;
  - subagent result headers (2.1.210, 2.1.277).
- **argv-only spawning** for every Glass-internal process (2.1.101, 2.1.110).

**Honest position recorded:** Glass doesn't detect injection; it bounds the damage. Adaptive attacks beat most published defenses, so the spec makes no detection claims.

ACs added: two new 08 criteria; the adversarial eval suite ([testing](../specs/testing.md)) gains a hidden-tag-character task.

---

## F-05.0 Provider connection: `/login`, the provider registry and models (owner-raised gap)

**Gap found by the owner:**
- The 13 settings example made custom provider blocks look required.
- There was no in-app `/login`.
- There was no per-provider choice of login method (subscription vs API key).

**How others do it:**

| Tool | Connect | Credentials | Notes |
|---|---|---|---|
| [OpenCode](https://opencode.ai/docs/providers/) | `/connect` → provider → method | plain `~/.local/share/opencode/auth.json` | ChatGPT, Copilot, GitLab Duo, xAI SuperGrok, DigitalOcean, Snowflake OAuth; Claude Pro/Max offered with a prohibition warning; models.dev catalog; per-provider model allow/deny lists; local servers configured manually |
| [Pi](https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@0.81.1/docs/providers.md) | `/login`, `/logout` | `~/.pi/agent/auth.json` (0600), auto-refresh | key from a command (`!op read …`); paste redirect URL or code when headless; order: flag → auth file → env → models.json; Claude Pro/Max offered "billed as extra usage" |
| [oh-my-pi](https://llmgateway.io/guides/oh-my-pi) | YAML config | `models.yml` | **model roles** (default, smol, plan, commit) |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/authentication-and-byok) | gateway key + dashboard BYOK | Vercel | no subscription login; a provider, not a login system |

**Policies (verified 2026-10-11):**
- **OpenAI:** "Sign in with ChatGPT" is official for open-source local apps since 2026-09-29 ([summary](https://xenospectrum.com/en/chatgpt-sign-in-subscription-apps/)).
- **GitHub Copilot:** official for OpenCode since 2026-01 ([GitHub](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/)).
- **Anthropic:** signals conflict. Terms reportedly prohibit subscription OAuth outside Anthropic's apps (Feb 2026), yet the Apr 4 email routes third-party use to extra usage ([TechCrunch](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/)). → SPIKE-38.
- **Google:** Antigravity CLI replaced Gemini CLI on 2026-06-18. Antigravity's Additional Terms prohibit accessing the service through third-party software with its OAuth; bans were reported, and Pi removed both providers ([forum](https://discuss.ai.google.dev/t/is-invoking-the-official-antigravity-cli-agy-print-from-a-third-party-developer-tool-an-acceptable-use/175462), [report](https://deepakness.com/raw/antigravity-omp-bans/)).

**Chinese providers:**
- They run separate China and international platforms with region-bound keys:
  - DashScope `aliyuncs.com` vs `-intl`;
  - Moonshot `.cn` vs `.ai`;
  - Zhipu `bigmodel.cn` vs `z.ai`;
  - MiniMax `minimaxi.com` vs `minimax.io`.

  A wrong-region key fails like a bad key ([Moonshot](https://docs.jambonz.org/guides/features/bring-your-own-llm/moonshot), [Z.ai](https://docs.cline.bot/provider-config/zai), [DashScope](https://docs.litellm.ai/docs/providers/qwencloud)).
- They sell coding plans as special keys and endpoints, often Anthropic-compatible ([MiniMax](https://platform.minimax.io/docs/coding-plan/claude-code), [Z.ai](https://docs.z.ai/scenario-example)).

**Decision: one generic approach** (spec: [providers "Provider registry"](../specs/providers.md), [cli-config "/login"](../specs/cli-config.md), [interfaces `ProviderRecord`](../specs/interfaces.md), [tui](../specs/tui.md), [vision](../product/vision.md)):
- **Provider = data record** listing endpoints (region × plan × protocol), auth methods (only officially permitted logins), billing kind (`per-token` / `plan`), model source and quirks. There is no per-company code.
- **Three record sources:**
  - curated (tested, in the binary);
  - generic, derived from models.dev's provider list (connectable without a release, labeled `community`);
  - user settings.
- **One `/login` flow** (provider → region/plan → method → credential → validate → model), shared by `glass auth login` and the first-run wizard.
- **Credentials:**
  - stored in the OS keychain (better than OpenCode's and Pi's plain files);
  - `cmd:` key sources, user scope only;
  - device or paste-code OAuth when headless;
  - an explicit resolution order;
  - per-provider model include/exclude.
- **Wrong-region key detection.**
- **Plan billing honesty:** tokens instead of invented dollars, `budget.tokens`, no automatic fallback to API-key billing.
- **The 13 example now shows `providers` as optional overrides.**

**Recorded for v0.2:** model roles per task (oh-my-pi's default/smol/plan/commit), alongside the existing `titles.model` and `failover.model`.

**New spikes:**
- SPIKE-36: Sign in with ChatGPT implementation.
- SPIKE-37: Copilot, xAI and OpenRouter login permissions.
- SPIKE-38: Claude extra-usage status.

SPIKE-21 is extended to the Chinese providers' Anthropic-compatible endpoints. ACs added: three new 13 criteria.

---

## User-journey sweep (after the owner found the `/login` gap)

**Lesson:** feature-by-feature research can't find gaps *between* features. Every stage of a user's life with Glass was walked through and mapped to a spec ([product/user-journeys.md](../product/user-journeys.md)). Ten steps had no spec:

| Gap | Fix |
|---|---|
| Reviewing all changes (pillar 6 had no view) | `/diff [turn]` ([tui](../specs/tui.md)) |
| Exiting: no summary or resume command | Exit summary with `glass --resume <id>` (tui) |
| Renaming sessions | `/rename` (tui) |
| Provider rate limits and plan usage invisible | `/usage` from rate-limit headers and plan reports, never guessed (tui) |
| Model deprecated or retired | Model lifecycle rules: warn, stop with the picker, resume asks, aliases pinned ([providers](../specs/providers.md)) |
| Switching from Claude Code: the "import offer" was never specified | Live read of the portable subset of Claude Code settings, no import step, writes go to Glass files ([cli-config](../specs/cli-config.md)) |
| Commit attribution: no policy | No attribution by default; `git.attribution: "trailer"`; project instructions win ([context](../specs/context.md)) |
| What data leaves the machine | "Data and privacy" section and `--offline` ([cli-config](../specs/cli-config.md)) |
| Custom status line, output styles | Explicitly v0.2 ([tui](../specs/tui.md)) |
| Stale wording: rewind said hard-linked files are written in place | Fixed ([checkpoints](../specs/checkpoints.md)) |

ACs added: three in 12, two in 13, one in 05, one in 09. AGENTS.md now requires updating the journeys file with every user-visible feature.

---

## F-07.11 WebFetch

**Source:** `F-07.11.txt` (56 entries, many of them redirect-related false matches).

**Design question settled:** our earlier spec returned up to 100,000 characters inline, about 28k tokens of main context per fetch. Claude Code avoids that with a summarizing model call, which Glass rejects (hidden cost, lossy). Glass now applies its own output rule instead: full Markdown saved to a pageable file, 30k characters inline, and the model Greps or Reads the rest. That's cheaper in context, has no hidden calls, and loses nothing.

**Lessons applied** (spec: [tools §9](../specs/tools.md), prompt):
- **Offset paging, no silent drop** (2.1.290).
- **Errors:**
  - dotless-host error explains itself (2.1.268);
  - "Don't retry this URL" stops loops (2.1.286);
  - one bounded retry for 429/503 (2.1.212);
  - error pages never passed off as content (2.1.212).
- **Timing:** a 30 s idle timeout plus the overall deadline (2.1.268).
- **Cache:** size-bounded, entries freed at TTL (2.1.239).
- **Conversion:** strip script/style before converting (2.1.105); bounded conversion with a fallback (2.1.117).
- **Binary downloads** saved with the right extension for Read (2.1.69).
- **Honest User-Agent;** `robots.txt` rules for `Glass-User` honored (2.1.83).
- **A stray `prompt` field accepted** (2.1.292).

ACs added: AC-TOOLS-42..43; the WebFetch prompt is rewritten.

---

## F-07.12 WebSearch

**Sources:**
- `F-07.12.txt` (21 entries);
- provider docs: [Kimi `$web_search`](https://platform.kimi.ai/docs/guide/use-web-search), [Qwen web search](https://help.aliyun.com/en/model-studio/web-search) (and a [third-party test](https://lilting.ch/en/articles/qwen37-qwen38-enable-search-test) showing that `enable_search` needs forced search, and sources only come back with `enable_source`);
- how other tools search: [OpenCode on Exa](https://forums.basehub.com/anomalyco/opencode/34), Pi's [pi-web-access](https://pi.dev/packages/pi-agent-web-access) (Exa, Brave, Tavily, Kagi, SearXNG, with fallback).

**Confirmed:** ADR-25 (search in a secondary request, never in the main history) avoids Claude Code's "every request fails on undecryptable web-search blocks" bug (2.1.282).

**Gap closed (same lesson as `/login`):** WebSearch worked only on Anthropic, OpenAI and Google; on DeepSeek, Kimi, GLM, Qwen or local models the tool vanished.

**Decision** (spec: [tools §10](../specs/tools.md), [providers](../specs/providers.md), [cli-config](../specs/cli-config.md), [interfaces](../specs/interfaces.md)):
- **Pluggable backends:**
  - `provider`: a per-endpoint `search` mechanism in the registry, covering Anthropic, OpenAI/Qwen Responses, Gemini, Kimi's built-in function and Qwen's flag;
  - search APIs: `exa`, `brave`, `tavily`, connected through `/login`;
  - self-hosted `searxng`.
- **Selection:** `auto` = provider, then a connected service, then the tool hidden with an explanation. The receipt names the backend.
- **Secondary request:** effort low, the model's valid thinking config (2.1.221, 2.1.295), today's date (1.0.36), its own retry budget, partial results kept (2.1.281), unsupported-model fallback (2.1.282).
- **Errors:** honest; never "0 results" or API-error text dressed up as results (2.1.141, 2.1.212).
- **Budget:** refills at 100 searches per hour instead of a hard cap (2.1.290).
- **Privacy:** the query destination is disclosed.

**Spike:** SPIKE-39 (Kimi, Qwen and GLM native search). ACs: AC-TOOLS-12 rewritten, AC-TOOLS-44 added.

---

## Prompts (system prompt, overlays, tool descriptions, harness texts)

**Sources (current, verified 2026-10-11):**
- Anthropic, [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) plus the per-model guides for [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5), [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5) and [Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1).
- OpenAI's GPT-6 Astra prompting best practices (mirrored in `openai/codex` skills).
- Codex's current base instructions (`codex-rs/protocol/src/prompts/base_instructions/default.md`) and its permission/sandbox prompt templates, `/init` prompt, compaction prompt and review rubric.

The owner flagged that the first references found (Codex's GPT-5.2 prompt files) were outdated. They were replaced by the files Codex currently uses.

**Gaps found and fixed:**

| Gap | Fix |
|---|---|
| One fixed prompt per family; vendors now document **per-model** differences (Fable 5.1 writes too few updates, Opus 5 too much, …) | Layered assembly: base → **model overlay** → session-state sections → conditional sections → environment → instructions ([prompts/README.md](../prompts/README.md), [context §2](../specs/context.md)) |
| The prompt didn't tell the model the permission mode or sandbox state (Codex does) | `modes/*.md`, the same texts used for mid-epoch mode changes |
| `gpt/system.md` was a 3-line diff, not a prompt | Full GPT base prompt with OpenAI's GPT-6 initiative, instruction-file transparency, writing-style and testing-calibration guidance |
| No prompt for other/local/Chinese models | `default/system.md`: short numbered rules |
| About 15 missing topics in the Claude prompt | Act-vs-answer, investigate first, finish the whole task (no announced-but-undone steps), compaction awareness, scope and follow-ups, no hard-coding or weakening tests, a real verification check with dependency rules, reversibility list incl. `--no-verify`, never reverting the user's changes, git rules incl. no amend, permission denials, mid-task messages, `<pasted_content>`, hidden characters, instruction-file scope, progress updates, standalone recap, reviews findings-first, writing style |
| Spec said the prompt carries git rules; it didn't | In all base prompts, plus an attribution trailer as a conditional section |
| No task-list tool (earlier non-goal) | **ADR-27:** `TodoWrite` / `update_plan`, a TUI panel, headless open-tasks continuation ([tools §12](../specs/tools.md)) |
| Unattended runs stop after a progress summary (Opus 5.5 guide) | `modes/headless.md` from the first request, plus a bounded open-tasks continuation ([agent-loop](../specs/agent-loop.md)) |
| Long turns could look silent: progress notes on Opus/Sonnet 5.5 are empty unless `display: "updates"` | `display: "updates"` in v0.1 (was v0.2), with a silence reminder after 5 quiet steps, max 2 per turn ([providers §3](../specs/providers.md), [agent-loop](../specs/agent-loop.md)); SPIKE-40 |
| Mid-task user messages misread as injection when mixed with harness text | Delivery rule: user text after the last tool result, harness notices separate, no per-step countdowns ([agent-loop](../specs/agent-loop.md)) |
| Pasted text could carry instructions as if from the user | `<pasted_content id>` tags with a random id per paste, explained in the base prompt ([tui](../specs/tui.md)) |
| Defaults: effort `high`, `max_tokens` 64k | The model's recommended effort (Opus/Sonnet 5.5: `medium`) and its max output (128k); per-message effort changes keep the cache ([providers §3](../specs/providers.md)) |
| Tool names with the wrong case failed | Case-insensitive unambiguous match (tools §0) |
| Compaction and `/init` prompts | Fable 5.1's preserve-list in `<summary>` tags; `/init` with Codex's section outline and an improve-don't-replace rule |
| Tool descriptions | Edit (closest-match errors, 50 MB, no placeholders), AskUserQuestion (header limit, unattended behavior), Enter/ExitPlanMode (when not to use), new TodoWrite |
| `budget.notifyModel` referenced but undefined | Added to settings (interfaces) |

**Checks added:** a prompt-parity test across the three base prompts, a prompt-snapshot test, and evals per profile and per overlay ([testing](../specs/testing.md)).

---

## F-11 Checkpoints and rewind

**Sources:**
- `F-11.txt` (26 entries). Claude Code uses per-file backups that don't cover shell commands, so few of its fixes transfer directly.
- [OpenCode v2 snapshots](https://opencode.ai/v2/docs/snapshots/): a separate git object database, no commits, index or ref changes, targeted restores of attributed paths, untracked files over 2 MiB excluded.
- Notes from other shadow-git agents (Docker's agent; a Go implementation whose undo points were lost to git's background gc).
- Gemini CLI's checkpointing (a shadow repo per project) is historical only: Gemini CLI was retired for individuals on 2026-06-18 in favor of the closed-source Antigravity CLI, so it is no longer a design reference.
- Codex no longer has an undo implementation.

**One-way door confirmed:** OpenCode independently converged on Glass's design. Glass is stricter on filter safety (filter-free plumbing).

**Lessons applied** (spec: [checkpoints](../specs/checkpoints.md), [context §6](../specs/context.md), [event-log](../specs/event-log.md), [tui](../specs/tui.md), [interfaces](../specs/interfaces.md)):
- **Snapshot store:**
  - untracked files over 2 MiB are excluded, while Glass's own tool edits stay restorable via blobs;
  - private-store auto-gc is disabled;
  - `checkpoints.enabled`.
- **Restores:**
  - verified by re-hashing, never reported as success when data is missing (2.1.260);
  - forks reference parent data rather than copying it, with GC counting fork references (2.1.275).
- **After a fork:** `--continue` targets the fork, and the post-rewind prompt is durable (2.1.295).
- **Picker:** lists queued messages, truncates previews, labels images (2.1.119, 2.1.290); `/undo` alias (2.1.108).
- **New "Summarize up to here"** (partial compaction; 2.1.141).

ACs added: four new 11 criteria.

---

## F-09.6 Compaction

**Sources:**
- `F-09.6.txt` (compaction entries);
- Codex's current compaction implementation (`codex-rs/core/src/compact_remote_v2.rs`, `compact_token_budget.rs`, `compact_model_fallback.rs`): retains user messages verbatim within a 64k-token budget next to the compaction output, keeps a smaller retry budget for compaction, uses a model fallback, and has a token-budget mode without summarization.

**Lessons applied** (spec: [context §5–6](../specs/context.md), compaction prompt):
- **The user's messages are kept verbatim** in the new epoch (a budget of min(32k, 10% of the window), oldest truncated first), and only the rest is summarized (Codex's design; makes "rules that stick" mechanical).
- **Summary content:**
  - an explicit finished/checked/in-progress state, to prevent redone or retracted work (2.1.293);
  - no request-like phrasing (2.1.119, 2.1.239);
  - the prompt rewritten to match the sections the spec now lists (fixing a mismatch between spec and prompt).
- **Glass facts extended:** last 5 tool actions, task list, mode, taint, session grants, working directories.
- **An oversized summary request** is reduced (images → placeholders, tool results trimmed, oldest turns dropped) instead of failing (2.1.85, 2.1.142, 2.1.269, 2.1.284).
- **Failure path:** retry, then `failover.model`, then a mechanical fallback with a notice (2.1.178, 2.1.282, 2.1.290).
- **Token estimates** survive zero usage reports (2.1.288).
- **The environment block** uses the current git branch after compaction (2.1.269).
- **No `$`-interpreting string replacement** of model text (2.1.268).
- **Window size** from server limits (2.1.117, 2.1.208, 2.1.260). Glass keeps its deliberate 400K cap on 1M models for cost.
- **UI:** scrollback kept (2.1.224); `/context` refreshed (2.1.218).
- **Fixed inconsistency:** the epoch table said per-message effort was v0.2 while 05 now uses it in v0.1.

**Not adopted for v0.1:** provider-native compaction (OpenAI's output is encrypted, which conflicts with principle 1). It's a v0.2 opt-in, labeled opaque.

ACs added: two new 09 criteria.

---

## F-10 Budgets, cost, receipts, claim checker

**Sources:**
- `F-10.txt`;
- Anthropic's [pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback) pages (verified 2026-10-11).

**Lessons applied** (spec: [receipts-budgets](../specs/receipts-budgets.md), [providers §3](../specs/providers.md), [agent-loop](../specs/agent-loop.md), [cli-config](../specs/cli-config.md), [interfaces](../specs/interfaces.md)):
- **Prices** keyed by provider + model (2.1.31).
- **Every model call costed and attributed by purpose** (2.1.77).
- **`usage.iterations`** priced per iteration at each model's rate; the served model comes from the top-level `model` field (2.1.285).
- **Refusal billing:**
  - pre-output refusals billed only for bio, frontier_llm and reasoning_extraction;
  - mid-stream refusals bill input plus streamed output;
  - the pre-output refusal retry is limited to unbilled categories.
- **Data residency:** a new `inferenceGeo` setting; `us` = ×1.1 on all categories for 4.6+ (2.1.239); regional cloud endpoints +10%.
- **Haiku 5.5 tier:** over 100k prompt tokens (cache included) prices the whole request higher.
- **Web search:** $10 per 1,000, errors free.
- **`/cost`:** cache-health line with miss causes (2.1.251, 2.1.260) and a per-purpose breakdown.
- **Claim checker:** recaps of earlier-turn changes no longer warn (fewer false positives).
- **Journey gap:** `glass cost` for spending history, which Claude Code users get from a third-party tool.

ACs added: three new 10 criteria.

---

## F-12 TUI (rendering, input, terminal handling)

**Sources:**
- `F-12_TUI.txt` (1,401 Claude Code entries, read in full and grouped: flicker/scrollback, resize, paste, IME, keyboard protocol, Unicode width, exit/terminal state, notifications/title, theme, performance, markdown, specific terminals, mouse/copy);
- our [tui](../specs/tui.md) as it stood.

**What the history shows:** about a third of all Claude Code fixes are TUI fixes. They fall into a few root causes, so Glass fixes the causes instead of listing symptoms:
1. **Re-printing scrollback** (2.1.94–2.1.121, a year of duplicated or lost history). Glass's rule "scrollback is immutable" already avoided this; the one exception (full re-render on width change, copied from pi-tui) is removed. The terminal reflows its own scrollback.
2. **Unbounded rendering work on model output** (~40 freezes, 2.1.203–2.1.295). Fixed with budgets: incremental parsing of the open block only, highlight time limit, line/table/nesting caps, 30 fps coalescing, input processed between render slices, zero idle work.
3. **Guessing terminal features by name** (2.1.110, 2.1.200, 2.1.269). Fixed by querying (DECRQM, Kitty query, OSC 10/11) with settings overrides; late replies are consumed, never typed into the prompt.
4. **Not restoring terminal state on every exit path** (2.1.0–2.1.260). Fixed by one restore routine on exit, signals, crash, suspend, editor hand-off; EIO → fast exit.
5. **Paste edge cases** (2.1.14–2.1.293). Fixed by a paste state machine with a 1 s end-marker timeout, which also keeps `<pasted_content>` marking (taint, [permissions §10](../specs/permissions.md)) correct.
6. **Raw escape sequences from untrusted text** (2.1.247, 2.1.277). New security section: all non-Glass text sanitized; SGR colors re-emitted; OSC 8 only from Glass with safe targets; children never get the TTY. Added to the threat model in [permissions §0](../specs/permissions.md).
7. **A render error ends the session** (2.1.236–2.1.287). Now: log, repaint, fall back to the plain renderer after 3 errors.

**Decisions kept:**
- **Inline renderer stays the default.** Claude Code moved to fullscreen by default (2.1.89, 2.1.110, 2.1.132) mainly to escape cause 1, which Glass's immutability rule already removes; inline keeps native scrollback, search and copy. Fullscreen stays fully supported.
- **Hardware cursor at the caret** for IME (Chinese, Japanese, Korean input) and screen readers (2.1.84, 2.1.140).

**Fixed in our spec:**
- The Esc row said queued messages are sent next; [agent-loop](../specs/agent-loop.md) says they move back into the input. 12 now matches 06.
- Ctrl+L never clears the input.

**New settings** ([interfaces](../specs/interfaces.md)): `ui.maxProseWidth`, `ui.terminalTitle`, `ui.syncOutput`, `ui.keyboardProtocol`.

**ACs added:** AC-TUI-14..18 (resize, rendering budgets, sanitization, terminal-state restore, input robustness).

**Still for SPIKE-4:** confirm pi-tui can be patched for live-region-only resize and the render-slice scheduler; if not, this is a vendored-copy change, not a library swap (TUI library is a swappable module in the ADR register).

---

## F-07.13 Plan mode

**Sources:**
- `F-07.13_Plan_mode.txt` plus plan entries in other files (about 60 entries, 1.0.33–2.1.292);
- Claude Code's [permission modes](https://code.claude.com/docs/en/permission-modes) and [settings reference](https://code.claude.com/docs/en/settings-reference) pages (plan approval options, `plansDirectory`, `showClearContextOnPlanAccept`, `useAutoModeDuringPlan`; read 2026-10-11);
- Codex's current plan-mode template, `openai/codex` `codex-rs/collaboration-mode-templates/templates/plan.md` (read 2026-10-11).

**Two designs, one per model family:**
- **Claude Code:** tools, plus a plan file the model writes; ExitPlanMode reads it.
- **Codex:** no tool; the model ends with a `<proposed_plan>` block, and the client offers to implement it.

Each model family is trained on its own form, so Glass uses both behind one approval dialog. Tools for the claude and default profiles; the tag for the gpt profile. Provider-neutral: any model in the default profile gets the tools.

**Lessons applied** (spec: [tools §11](../specs/tools.md), [permissions §2](../specs/permissions.md), [context §6](../specs/context.md), [event-log](../specs/event-log.md), [tui](../specs/tui.md), [interfaces](../specs/interfaces.md), prompts):
- **Plan file as source of truth:**
  - named from the prompt without paste placeholders (2.1.111, 2.1.154); the only writable file in plan mode;
  - new on `/clear` (2.1.3); a fork gets its own copy (2.1.71);
  - re-attached after compaction (2.1.47); a plan written in the same response is the one shown (2.1.285).
- **ExitPlanMode:**
  - takes an optional inline `plan`, so models trained either way work;
  - an empty plan gives a simple yes/no dialog (2.0.68);
  - after approval it returns an error, never a second dialog (2.1.76).
- **Approval dialog:**
  - "return to previous mode" first (2.1.105);
  - multi-line feedback, with digits typing into the field (2.1.69, 2.1.72);
  - Ctrl+G edit, labeled edited only if the bytes changed (2.1.210);
  - a title from the plan;
  - leaving plan mode while the dialog is open closes it with a clear result.
- **Persistence:** every resume path (2.1.246, 2.1.290, 2.1.292), compaction (2.1.47), forks and subagents inherit and can't leave (2.1.285).
- **Blocks:** plan mode overrides allow rules and sandbox auto-allow (2.1.136, 2.1.212), already in 08. **[GLASS] divergence:** Claude Code stops enforcing plan blocks in terminal sessions where bypass is available; Glass enforces them always, for predictability.
- **Prompt conflicts:**
  - plan mode text takes precedence over "act on requests" and headless autonomy (auto-mode conflict, 2.1.119);
  - execution requests in plan mode are planned, not executed (Codex);
  - headless plan mode records open questions as assumptions.
- **Plan content** ("decision complete", compact sections Summary / Changes / Verification / Assumptions, explore before asking, 2–4 options with a recommendation) written into both plan-mode texts.
- **`/plan <text>`, `/plan open`** (2.1.72, 2.1.119); optional **planning model** `plan.model` (Claude Code's `opusplan`), with its cache cost shown.

**Not adopted:**
- Codex-style "tests and builds that write only caches are allowed": Glass can't verify which files a command writes before it runs, so such commands prompt instead.
- The "approve and clear context" option: Claude Code hides it by default since 2.1.81; deferred.

ACs added: three new 07 criteria (plan mode flow, persistence, gpt profile).

---

## First-principles review of the one-way doors (owner request, 2026-10-11)

**Trigger:** the owner asked to go back to first principles: question the assumptions, and separate Type 1 (hard to reverse) from Type 2 (reversible) decisions.

**Finding:** the register's "evidence" column was mostly analogy ("Claude Code does it"). Each door now has Glass's own reason ([decisions](../plan/decisions.md)):
- **Holds on its own reasons:** TypeScript/Bun, raw replay + epochs, own adapters, module boundaries, AGENTS.md/CLAUDE.md, public schemas, install layout.
- **Sharpened, JSONL:** any cross-session index is declared a disposable cache rebuilt from the logs, so it never becomes a second one-way door.
- **Re-founded, permissions (ADR-28):**
  - **Fundamentals:** command text can't be judged reliably, effects can be enforced by the OS, people approve blindly when asked too often, and workspace edits are reversible through checkpoints.
  - **Decision:** decide on effects; free inside the boundary, ask when crossing it; every prompt names its boundary; Claude Code's syntax kept as the input format.
  - **Current practice confirms it** (verified 2026-10-11):
    - Codex retired per-command approval (`untrusted`); its command rules apply only outside the sandbox; its auto-reviewer sees only escalations.
    - Claude Code's default is now a classifier, with the sandbox off by default and native Windows unsandboxed.
- **Gap found by the new frame:** once a host is allowed, the sandbox can't tell a clone from a push, so the vision's "no autonomous push" was enforced only by user ask rules. Fixed: a built-in remote-action list ([permissions §4.8](../specs/permissions.md)) asks for push/publish/deploy/upload commands even when sandboxed.
- **Also added:** rule examples checked at load (`permissions.examples`); (v0.2) reviewer placement on escalations only.
- **Missing doors added:**
  - the **license** (ADR-29: MIT, owner decision);
  - **public extension contracts** (v0.2 hooks/skills/MCP/ACP must follow existing standards and be versioned).
- **Windows:** Codex now uses Microsoft Execution Containers (MXC) on Windows 11 without admin setup (single news source, Oct 9, 2026). It's a candidate for a first-class Windows sandbox [SPIKE-42].

**Process:** the per-feature research loop continues as before (owner, 2026-10-11).

---

## Closing open questions + the AI SDK decision (owner, 2026-10-12)

**Owner decisions** (open-questions "Product decisions"):
- name **Dovet**; refusal fallback off; model-recommended effort; compaction at 90% of the usable window;
- no telemetry (`dovet bug`), no default budget;
- Windows sandbox MXC → admin setup → none; Git Bash first with consented winget install;
- no paid code signing (SignPath for Windows).

**Model layer (ADR-30, replaces ADR-2):**
- **Prompt:** the owner asked why Dovet writes provider code when the AI SDK's maintained packages cover every provider.
- **Checked 2026-10-12:**
  - `ai` 7.0.137;
  - `@ai-sdk/*` packages released 2026-10-08/09, including dedicated packages for DeepSeek, Alibaba (Qwen), Moonshot (Kimi), MiniMax, xAI, Groq, Open Responses and the Gateway;
  - Anthropic: `display` modes, per-message effort and turn-scoped system messages (`allowSystemInMessages`, betas added automatically), 1-hour cache control, `inferenceGeo`;
  - OpenAI: encrypted reasoning, `shell`/`apply_patch` tools, namespaced function calls;
  - Gemini: the Interactions API;
  - Chinese providers' `reasoning_content` replay;
  - normalized cache usage, request bodies and raw chunks;
  - custom `fetch`.
- The old ADR-2 reasons ("unifying layers normalize raw fields away or lag") no longer hold.
- **Decision:** Dovet's own loop calls `streamText` for one step; everything else stays Dovet's.

**Ecosystem review (ADR-24):**
- not used: `@ai-sdk/tui` (too minimal for Dovet's TUI), `ToolLoopAgent`;
- candidates: `@ai-sdk/mcp` (v0.2), `@ai-sdk/code-mode` (v0.3), `@ai-sdk/harness` (v0.2 adapter), `@vercel/agent-eval` (SPIKE-43).

**Spikes closed by research:**
- 1 (models.dev tiers), 7 (decided: always map IDs), 8 (OpenAI native tools);
- 26 / 31 (PDFs), 29 (Anthropic search usage), 36 (Sign in with ChatGPT, full flow into 13);
- 37 (OpenRouter yes; Copilot / xAI no impersonation), 39 (Qwen Responses search only), 40 (`summarized` display; per-message effort), 41 (rule: official model cards only).

**Still open:** 26 items, all needing code or live runs (each with a fallback), plus SPIKE-20/27 for v0.2.

---

## Documentation consistency review (owner request, 2026-10-12)

**Request:** make the plans tell one story an agent can build from without guessing: no Claude-specific framing of the product, no history or outdated notes in specs, every feature's status clear.

**Changed:**
- **Vision:** the audience is no longer framed around Claude's limits. Login methods are per provider (API key, permitted account login, coding-plan key, none for local), as registry data. Claude account login is not offered unless Anthropic explicitly allows it.
- **History removed from specs:** about 600 version citations and "revised/added/fifth pass" markers, plus sentences narrating other tools' bugs. Requirements were kept and restated; evidence stays in this log.
- **Background split:** this log, the design review and the sources moved to `docs/background/` with a "not a spec" banner.
- **README:** a feature-status table (milestone, later, not supported) and a key-terms glossary.
- **AGENTS.md:** current state, what is normative, provider neutrality, license notices for copied code.

**Contradictions fixed:**
- Effort default (ADR-14 vs 05): the model's recommended level.
- Thinking display (providers): chosen by capability.
- PDF page limit: 8 at the default token limit.
- Parallel-safe vs early-executed tools (architecture, 06): parallel-safe is Read, Grep, Glob, WebFetch, WebSearch; early execution is local reads only.
- `update_plan` in plan mode, and TodoWrite not parallel-safe.
- Hard-link AC (tools): AC-TOOLS-23 vs AC-TOOLS-31.
- Credential resolution order (cli-config), given twice in different orders. Now one order: settings reference → `/login` credential → env var; there is no `--api-key` flag.
- Network paths (08 vs 15): refused by file tools.
- Reads outside working directories (permissions §0b vs §1).
- Force-push rule (permissions §4.8 vs §5); push wording in the vision.
- Duplicate hook sections and version mismatches (extensibility, 17: background tasks, per-message effort, provider compaction).
- Stale spikes (SPIKE-12, -24, -28, -38, Q4).
- Missing types: instruction reasons, `Effects` on every action, `review-edit`/`remote-action`/`no-sandbox` ask reasons, JSON output fields incl. `incomplete`.
- Missing gpt tool prompts (`update_plan`, `request_user_input`).
- `/copy` clipboard order; paste-marking threshold.

**Checks run:** all relative links resolve; every settings key used in a spec exists in interfaces §7; every SPIKE and AC reference exists; no duplicate AC IDs.

---

## F-07.5 Asking the user: AskUserQuestion / request_user_input

**Sources:**
- `F-07.5_AskUserQuestion.txt` and related entries (2.0.21–2.1.290);
- the AskUserQuestion tool schema as Claude models receive it;
- Codex's `request_user_input` (tool spec, handler and protocol types; read 2026-10-12).

**Two trained shapes:**
- **Claude:** 1–4 questions, 2–4 options with optional previews, `multiSelect`; answers are keyed by question text.
- **GPT:** 1–3 questions with a snake_case `id`, 2–3 options, single choice, "Other" added by the client; answers are JSON keyed by `id`.

Glass gives each profile its trained shape, behind one dialog and one normalized `AskUserQuestionInput` ([interfaces](../specs/interfaces.md)). The `default` profile uses AskUserQuestion.

**Lessons applied:**
- No auto-continue timeout (2.1.200).
- Neutral result wording: no "continue" instruction, so a free-text "wait" is respected (2.1.216).
- Typed Other kept in multi-select (2.1.181); multi-select answers arrive as an array (2.1.136).
- Notes attach to the highlighted option (2.1.274); Esc in a text field returns to selection (2.1.144).
- Previews word-wrap (2.1.181) and render once per option (2.1.70).
- Single-question, single-choice submits without a review screen (2.0.55); "(Recommended)" first (2.0.62).
- Reserve questions for genuine decisions (2.1.154).
- A dismissed dialog ends the turn so the user can type (the "chat about this" need).
- v0.2: only the root session asks (Codex); hooks may answer (2.1.85).
- Headless sessions don't declare the tool at all, saving a failing round trip; `dontAsk` returns the no-user error.

**ACs added:** AC-TOOLS-49, AC-TOOLS-50.

---

## Provider-neutrality audit (after the owner's reminder that Glass is not Claude-only)

Recent rounds leaned on Anthropic's documentation. This audit checked where non-Anthropic providers were under-specified:

| Gap | Fix |
|---|---|
| "Never send temperature" was an Anthropic rule applied to everyone; open models publish agentic sampling values (Qwen 3.6, Kimi K2.6, GLM-4.7, DeepSeek) | Per-model `sampling` in the registry from vendor model cards; sent only where accepted ([providers](../specs/providers.md)); SPIKE-41 |
| Cached-token fields differ per provider (DeepSeek `prompt_cache_hit_tokens`, Kimi `cached_tokens`, Qwen `prompt_tokens_details.cached_tokens`), so costs and cache stats would be wrong | `usageFields` mapping per record; generic `automatic-prefix` and `explicit-markers` caching kinds; unmapped = "not reported" ([providers](../specs/providers.md), [receipts-budgets](../specs/receipts-budgets.md)) |
| Refusals and content filters only modeled for Anthropic | One normalization table: Responses `refusal` part, Chat `content_filter` (incl. DeepSeek's empty-content form), Gemini `SAFETY`/`PROHIBITED_CONTENT`, provider policy error codes ([providers](../specs/providers.md)) |
| Reasoning replay rules only for Anthropic/OpenAI/Gemini | `reasoningReplay` quirk for chat-protocol reasoning models (Kimi/DeepSeek thinking with tools) ([providers](../specs/providers.md)) |
| Model overlays only for Claude/GPT | Overlay policy covers all families; open-model vendor guidance is mostly parameters, which live in the registry (model overlays were later removed: one prompt for every model, ADR-31) |

Sources: [DeepSeek KV cache](https://api-docs.deepseek.com/guides/kv_cache), [DeepSeek API reference](https://platform.deepseek.com/api-docs/zh-cn/api/create-chat-completion), [Kimi context caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api.md), [Qwen context cache](https://help.aliyun.com/zh/model-studio/context-cache), [OpenAI Chat reference](https://developers.openai.com/api/docs/api-reference/chat), [Kimi K2.6](https://unsloth.ai/docs/models/kimi-k2.6), [GLM-4.7](https://docs.api.nvidia.com/nim/reference/z-ai-glm4-7). Several values come from secondary sources; SPIKE-41 confirms each against official cards.


## Vercel ecosystem audit (2026-10-12)

**Question:** which Vercel / AI SDK packages already do something Dovet planned to write itself (owner rule: use maintained packages, write only what's ours)?

**Method:** listed every package in the `vercel/ai` monorepo (90 packages), every `vercel` and `vercel-labs` repository pushed in 2026, and every export of `ai` 7.0.137 from its type declarations; read the README and npm metadata (license, engines, dependencies) of each candidate.

**Adopted:** `ai` middlewares (`extractReasoningMiddleware` for inline `<think>` reasoning, `simulateStreamingMiddleware` for non-streaming servers) as endpoint quirks; `parsePartialJson` (drops the `partial-json` dependency); `ai/test` mocks for loop, Session-API and soak tests; `@ai-sdk/mcp` as the v0.2 MCP client (2026-07-28 + legacy, OAuth with CIMD and issuer check); `@vercel/agent-eval` as the eval runner (SPIKE-43 closed); the `skills` CLI's install folders (SPIKE-20 closed); `@ai-sdk/harness-acp` makes a Dovet harness package unnecessary once ACP ships; `just-secrets` as the keychain fallback (SPIKE-5); `guarded-fetch` for WebFetch SSRF protection (new SPIKE-45: undici under Bun); `AI_AGENT=dovet` in shell environments (the `detect-agent` convention); `dependency-cruiser` (outside Vercel, same rule) for the import-boundary check; `@ai-sdk/codemod` dev-only.

**Rejected, with reasons in ADR-24:** `toolApproval`/`@ai-sdk/policy-opa` (permissions are decided on effects by Dovet's engine; a second rule language would split policy), `experimental_repairToolCall`, `pruneMessages`, SDK retries, `@ai-sdk/tui`, the harness and sandbox packages, `just-bash`, OTel, `@vercel/error`/`nostics`, web UI packages, `konsistent` (structure, not import edges).

**Correction found:** the AI SDK packages are **Apache-2.0**, not MIT. Compatible with MIT Dovet; the release now generates `THIRD_PARTY_NOTICES` with license texts and `NOTICE` files (AC-ARCH-05). `@ai-sdk/zai` (GLM) added to the provider package list.

Sources: [vercel/ai packages](https://github.com/vercel/ai/tree/main/packages), [vercel-labs repositories](https://github.com/vercel-labs), [@ai-sdk/mcp](https://www.npmjs.com/package/@ai-sdk/mcp), [@vercel/agent-eval](https://github.com/vercel-labs/agent-eval), [skills CLI](https://github.com/vercel-labs/skills), [just-secrets](https://github.com/vercel-labs/just-secrets), [guarded-fetch](https://github.com/vercel-labs/guarded-fetch), [detect-agent](https://github.com/vercel/detect-agent), [@ai-sdk/policy-opa](https://github.com/vercel/ai/tree/main/packages/policy-opa), [@ai-sdk/harness-acp](https://github.com/vercel/ai/tree/main/packages/harness-acp), [dependency-cruiser](https://www.npmjs.com/package/dependency-cruiser).

## Broken tool calls: prevent instead of repair (2026-10-12)

Owner question: why would a model hit the "3 malformed rounds" guard at all; isn't there a better approach than error-and-retry? Answer: yes, prevention. Anthropic's strict tool use (`strict: true`) constrains sampling to the tool schema, guaranteeing valid names, types and required fields (limits: 20 strict tools, 24 optional and 16 union parameters per request; grammar compiled on first use, cached 24 h). The AI SDK passes `strict` through. Adopted in providers "Valid tool calls by construction"; other providers pending SPIKE-46. Also: validation errors now end with one valid example call (`ToolDefinition.errorExample`), and the malformed-rounds pause suggests a larger model. Repair by guessing stays rejected (wrong-file and wrong-command risk).

Sources: [Anthropic strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use), [Anthropic structured outputs limits](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [OpenAI structured outputs announcement](https://openai.com/blog/introducing-structured-outputs-in-the-api), [llama.cpp lazy tool-call grammars](https://cdn04132025.gitlink.org.cn/replica/llama.cpp/commit/669912d9a5bf927312c553332ff997f0a99da8fb).

## How OpenCode structures providers (2026-10-12)

Owner asked to check OpenCode instead of ordering providers by priority. Source read: `anomalyco/opencode` `dev` branch (MIT).

- **All providers, equal:** a models.dev plugin adds every models.dev provider (with its env-var names) automatically; there is no priority list.
- **Per-provider code only where needed:** ~30 provider plugins (`packages/core/src/plugin/provider/*.ts`: OpenAI/ChatGPT login, GitHub Copilot, Bedrock, Vertex, Ollama, LM Studio, vLLM, OpenRouter, xAI, …) hook auth, options and model lists. A `DynamicProviderPlugin` installs any other provider's npm package (models.dev `npm`) at runtime.
- **Model layer:** OpenCode v2's core uses its own `@opencode/ai` (Effect-based, native protocol routes: OpenAI Responses/Chat, Anthropic Messages, Gemini, Bedrock Converse, OpenAI-compatible profiles) and removed the Anthropic/OpenAI/Bedrock/Azure/OpenAI-compatible AI SDK packages (PR #43115). AI SDK packages remain as a bridge pinned to the v6 line (PR #53287) after v7 packages loaded at runtime broke sessions (#50960). OpenCode v1 moved to AI SDK v7 (PR #52064). No PR states why v2 went native.

Applied to Dovet: the roadmap has no provider priority (every models.dev provider through the registry from M4); **provider modules** (`ProviderModule`, interfaces §3) are the per-provider code hook; the endpoint type now carries its `package`. ADR-30 kept, with OpenCode's move recorded as counter-evidence and the M1 fidelity gate (SPIKE-44) as the decision point.

## Log format independent of the AI SDK (2026-10-12)

Input: an OpenCode contributor (Discord, via the owner) on why OpenCode replaced AI SDK packages with its own code: easier to maintain and change, free of library bugs, and SDKs "require bypasses to do anything they did not think up"; advice: base on the SDK, a custom solution is better but costs time, which LLMs reduce. Decision (owner approved): keep ADR-30, but `model.response` now stores Dovet's own parts with provider replay data (wire-format field names) instead of AI SDK message objects, with a lossless round-trip contract test (AC-PROV-18). Replacing the SDK for a protocol later then needs no log migration; replacement happens per protocol on evidence only.

## Full review (2026-10-12)

Read every spec, prompt index and workflow file end to end, plus automated checks (links, criterion IDs, spike and ADR references, settings keys, instruction keys). Fixed: leftovers from the AI SDK and log-format decisions (ADR-4 wording, "four protocol adapters", raw response bodies now stored only with `--debug` to protect the disk budget), stale Windows sandbox and keychain rows in 15, the strict-tools fallback (now a new epoch, since tool definitions are frozen per epoch) and zod-generated `minimum`/`maxLength` keywords moved into descriptions, OpenAI caching capability names aligned with 21, a missing `effortField` quirk, resolved spikes still cited as open, missing env vars in interfaces §8, missing criteria for Sign in with ChatGPT, `dovet bug`, `dovet cost` and `--explain-defaults` (AC-CLI-20..22), the spec-coverage check (now only for tasks marked done, so CI is green from the first PR), an undeclared `tui-demo` command in M0, and product decisions Q10–Q12 recorded in 19.

## Docs restructured; `next` command (2026-10-12)

Owner feedback: the numbered file names mixed feature specs with planning and workflow files, had gaps, and nothing guaranteed the agent reads the right files. Done: docs moved into role folders with plain names (`workflow/`, `plan/` incl. `tasks/`, `specs/`, `product/`, `prompts/`, `background/`); every link and reference rewritten by script and checked; acceptance criteria renamed after their spec (`AC-TOOLS-04`, IDs unchanged otherwise). Added `scripts/next.py`: prints questions waiting for the owner, recent progress, the current milestone, the next task and the exact spec sections its Read line names (with their "Before you build" boxes), so an agent's reading no longer depends on it choosing the right files (M0-01's reading: ~2,500 words instead of ~82,000). AGENTS.md (auto-loaded by every major coding agent) now starts with that command and carries the non-negotiable rules itself. M0-01 ports both scripts to TypeScript (`bun run next`, `bun run docs:check`).

## One prompt and one tool set for every model (2026-10-12, ADR-31)

Owner decision: prompts must be the same for every model, not split by vendor. Removed the `claude`/`gpt`/`default` tool profiles, the GPT-only tools (`apply_patch`, native `shell`, `request_user_input`, `update_plan`, `<proposed_plan>`), per-model prompt overlays and the overlay-only `batch-reminder`. `docs/prompts/` is now one set: `system.md` (the former Claude prompt, already vendor-neutral, plus the instruction-file transparency and style points from the GPT prompt), `tools/`, `modes/`, `conditional/`, `compact.md`, `init.md`, `instructions.md`. Shell variants stay, chosen by the user's detected shell, not the model. Per-model differences are data (effort, thinking display, sampling, strict tools, caching). SPIKE-13 now asks whether any model family gains measurably from a variant; only then an ADR adds one. Tools spec sections renumbered (§4 questions, §5 Bash, §6 PowerShell, §7 Grep, §8 Glob, §9 WebFetch, §10 WebSearch, §11 plan mode, §12 TodoWrite).
