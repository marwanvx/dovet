# Bun Documentation Snapshot

An offline, AI-friendly snapshot of the official Bun documentation (https://bun.com/docs).

- **Fetched:** 2026-10-21
- **Bun version at fetch time:** 1.4.3
- **Source:** official markdown export at https://bun.com/llms.txt (every docs page is available as clean markdown)
- **Pages:** 319 markdown files (~2105 KB of text)
- **License:** Bun and its documentation are MIT-licensed by Oven (source: github.com/oven-sh/bun). This is an unmodified snapshot for offline/AI use.

## What's inside

```
bun-docs/
├── README.md          ← you are here
├── llms.txt           ← index of all pages (title + one-line description + relative path)
├── llms-full.txt      ← the entire documentation as one 2086 KB file
└── docs/              ← the actual documentation, mirroring bun.com/docs URL structure
    ├── index.md           (Welcome to Bun)
    ├── installation.md
    ├── quickstart.md
    ├── typescript.md
    ├── runtime/           (Bun.serve, file I/O, SQL, S3, Redis, FFI, workers, ...)
    ├── pm/                (bun install, lockfile, workspaces, registries, ...)
    ├── bundler/           (bun build, loaders, macros, executables, ...)
    ├── test/              (bun test, mocks, snapshots, coverage, ...)
    └── guides/            (~120 practical how-to guides)
```

## How to use with an AI assistant

1. **Recommended — let the agent browse the folder.** Put the `bun-docs/` folder in your project and point your AI tool at it. Instruct the agent to read `bun-docs/llms.txt` first (it's a compact table of contents with one-line descriptions), then read the specific pages it needs from `bun-docs/docs/`.

   Example snippet for `CLAUDE.md` / `.cursorrules` / `AGENTS.md`:

   ```
   ## Bun documentation
   Complete Bun docs live in `bun-docs/`. When working with Bun APIs:
   1. Read `bun-docs/llms.txt` to find the relevant page (title + description per line).
   2. Read the specific file(s) under `bun-docs/docs/` before writing Bun-specific code.
   ```

2. **Single-file mode — `llms-full.txt`.** The whole docs as one file, following the llms.txt convention. Useful to diff/update or to hand to tools that accept one big file. Note it is ~2086 KB (~534k tokens), which exceeds most context windows — prefer the folder approach and let the AI read individual pages on demand.

3. **Keep it fresh.** To update the snapshot later, re-download the official markdown: the page list lives at https://bun.com/llms.txt and each page is at `https://bun.com/docs/<path>.md`.
