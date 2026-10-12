# Vendored pi-tui

- **Source:** `packages/tui/src` of https://github.com/earendil-works/pi at tag `v1.1.0` (commit `abe508e1b89912adde45528136c3221eb69acdd7`), published on npm as `@earendil-works/pi-tui` 1.1.0. MIT, see `LICENSE` (copied from the repository root).
- **Why vendored:** ADR-5 in `docs/plan/decisions.md`.
- **Its dependencies:** `marked` 18.0.11 and `get-east-asian-width` 1.6.0, pinned in Dovet's `package.json` (ADR-15).

## Dovet's changes

Every change is marked with a `Dovet:` comment, or is a whole file listed here, so a re-sync with upstream is a diff of these:

- Removed `native-modifiers.ts`, `native-module-path.ts` and `native-platform.ts` (the clipboard and modifier `.node` addons, ADR-5) and the `getNativeClipboard` export from `index.ts`.
- `terminal.ts`: Shift+Enter is no longer detected from the OS modifier state on Apple Terminal and Windows (the addon did that); on Windows, `ENABLE_VIRTUAL_TERMINAL_INPUT` is set through `windows-console.ts`.
- `tui-main-screen.ts`: inline frames are drawn with auto-wrap off (`BEGIN_FRAME`/`END_FRAME`), as `TuiAltScreen` already does. On GNOME Terminal, 👍🏽 is drawn wider than `visibleWidth()` measures it, so a padded full-width line wrapped and every later frame landed one row lower, leaving stale copies (SPIKE-4, owner's run).
- Added `windows-console.ts` (kernel32 through `bun:ffi`, replacing the Windows part of the addon).
- Added `tsconfig.json`: type-checked as its own project with upstream's strictness (QUESTIONS Q7).

Not changed yet, and required by `docs/specs/tui.md` (SPIKE-4): width changes re-render only the live region, and rendering runs in ≤ 8 ms slices between input events.
