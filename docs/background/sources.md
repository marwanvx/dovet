# Sources (research pass 2026-10-10)

> **Background, not a spec.** Written while the product's codename was "Glass"; it is now **Dovet**. This file records research and history: what was checked, where, and why decisions were made. It may describe earlier states of the plan. The specs (00–19, 21, 23, prompts/) are the source of truth; if this file disagrees with them, the spec wins.

## Problems and user evidence
- InfoQ — Anthropic traces six weeks of Claude Code complaints to three product changes: https://www.infoq.com/news/2026/05/anthropic-claude-code-postmortem/
- Fortune — Anthropic explains Claude Code's performance decline: https://fortune.com/2026/04/24/anthropic-engineering-missteps-claude-code-performance-decline-user-backlash/
- The Register — surprise usage limits: https://www.theregister.com/2026/01/05/claude_devs_usage_limits/
- Codex capacity errors issue: https://github.com/openai/codex/issues/43738
- TechTimes — Codex SSD write bug: https://www.techtimes.com/articles/318876/20260622/openai-codex-cli-bug-silently-writes-640-tb-year-your-ssd-no-patch.htm
- The Hacker News — GitHub issue reaches CI secrets: https://thehackernews.com/2026/08/claude-code-and-gemini-cli-flaws-let.html
- Stack Overflow 2026 survey coverage: https://byteiota.com/stack-overflow-2026-survey-developers-use-ai-agents-but-actively-avoid-them/
- Sonar State of Code 2026: https://www.sonarsource.com/state-of-code-developer-survey-report.pdf
- Pi locked out of Claude subscriptions: https://yage.ai/share/pi-coding-agent-locked-out-en-20260518.html

## Harness design lessons
- Harness Engineering: a source-code study of eleven systems (arXiv 2609.00006): https://arxiv.org/html/2609.00006v1
- The Devil Is in the Interface: tool architecture study (arXiv 2608.11386, COLM 2026): https://arxiv.org/pdf/2608.11386
- Hidden Technical Debt of AI Systems: Agent Harness: https://leehanchung.github.io/blogs/2026/05/08/hidden-technical-debt-agent-harness/
- Mario Zechner — building Pi: https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- Claude Code renderer rewrite (Anthropic): https://x.com/trq212/status/2001439019713073626
- The Signature Flicker: https://steipete.me/posts/2025/signature-flicker
- CLAUDE_CODE_NO_FLICKER history: https://slyapustin.com/blog/claude-code-no-flicker.html
- OpenCode Ink evaluation issue: https://github.com/anomalyco/opencode/issues/2956
- DevClass — why Codex moved to Rust: https://devclass.com/2025/06/02/node-js-frustrating-and-inefficient-openai-rewrites-ai-coding-tool-in-rust/
- MCP context bloat fixes: https://mcp.directory/blog/mcp-context-bloat-fix-2026-tool-search-code-mode-progressive-disclosure
- Anthropic acquires Bun: https://anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone

## Reference implementations
- Codex workspace Cargo.toml: https://github.com/openai/codex/blob/main/codex-rs/Cargo.toml
- OpenCode package.json: https://github.com/sst/opencode/blob/dev/packages/opencode/package.json
- Pi (pi-mono) packages: https://github.com/badlogic/pi-mono
- pi-tui README: https://github.com/badlogic/pi-mono/blob/main/packages/tui/README.md

## APIs and libraries
- Anthropic API: facts verified from the claude-api reference bundled with Claude Code (models, thinking, caching, preserved thinking, tool use, errors), cached 2026-10-06; live docs: https://platform.claude.com/docs
- Anthropic sandbox-runtime: https://github.com/anthropics/sandbox-runtime
- OpenAI apply_patch guide: https://developers.openai.com/api/docs/guides/tools-apply-patch
- OpenAI Responses streaming events: https://developers.openai.com/api/reference/resources/responses/streaming-events
- OpenAI reasoning items cookbook: https://developers.openai.com/cookbook/examples/responses_api/reasoning_items
- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Gemini thought signatures: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
- models.dev: https://github.com/sst/models.dev
- MCP spec 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- ACP Rust/TS libraries: https://agentclientprotocol.com
- AGENTS.md under the Agentic AI Foundation: https://openai.com/index/agentic-ai-foundation/
- Claude Code on Windows (PowerShell tool history): https://github.com/anthropics/claude-code/issues/53068 and https://agentpatterns.ai/tools/claude/powershell-tool/
- npm registry (package versions checked 2026-10-10): https://www.npmjs.com/
