// `tui-demo`: the SPIKE-4 test program (docs/plan/open-questions.md). Not part of the `dovet` command.
// It drives the vendored pi-tui core (src/tui/vendor/pi-tui, no native addons) the way Dovet will: a reply streamed as
// markdown, an input editor, an overlay and a status line that shows what the terminal sent and answered.
//
//     bun scripts/tui-demo.ts               # inline mode (keeps the terminal's scrollback), like Dovet's default
//     bun scripts/tui-demo.ts --alt         # fullscreen (alternate screen)
//     bun scripts/tui-demo.ts --self-test   # no terminal needed: renders into memory and prints what was drawn
//     bun scripts/build.ts --tui-demo <out> # compile it into a single executable (Dovet's compile options)
//
// The dispatch at the bottom runs unconditionally: in a compiled Windows executable `import.meta.main` is false, so
// this file is only ever an entry point, never imported. CI compiles it per OS and attaches it to the run (ci.yml, "tui-demo" artifacts) for the owner's terminal checklist.
import {
  Box,
  backgroundAnsi,
  type Color,
  type Component,
  Container,
  colorToHex,
  Editor,
  type EditorTheme,
  foregroundAnsi,
  getTerminalColorMode,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  type ProgramStatus,
  parseKey,
  rgbColor,
  type SelectListTheme,
  stripTerminalSequences,
  type Terminal,
  type TerminalColors,
  Text,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
} from "../src/tui/vendor/pi-tui/index.ts";
import { enableWindowsVirtualTerminalInput } from "../src/tui/vendor/pi-tui/windows-console.ts";

const style = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const bold = style(1, 22);
const dim = style(2, 22);
const italic = style(3, 23);
const cyan = style(36, 39);
const yellow = style(33, 39);
const green = style(32, 39);
const blue = style(34, 39);

const selectListTheme: SelectListTheme = {
  selectedPrefix: blue,
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
};
const editorTheme: EditorTheme = { borderColor: dim, selectList: selectListTheme };
const markdownTheme: MarkdownTheme = {
  heading: (s) => bold(cyan(s)),
  link: blue,
  linkUrl: dim,
  code: yellow,
  codeBlock: green,
  codeBlockBorder: dim,
  quote: italic,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic,
  strikethrough: style(9, 29),
  underline: style(4, 24),
};

/** The streamed reply: every block type the TUI must handle, plus wide and combining characters. */
const SAMPLE_REPLY = `# Streaming markdown

This reply arrives a few characters at a time, like a model's. **Bold**, *italic*, \`inline code\` and a [link](https://example.com).

- Wide characters: 日本語の文章, 中文, 한국어
- Emoji and flags: 👍🏽 👨‍👩‍👧 🇯🇵, combining accents: é (e + U+0301)
- A long line that has to wrap at the terminal's width, so resizing the window while it streams shows how wrapping is redone.

| Terminal | Mode | Result |
|---|---|---|
| Windows Terminal | inline | ? |
| tmux | inline | ? |

\`\`\`ts
const greeting = "hello";
console.log(greeting);
\`\`\`

> A quote, then the end of the reply.
`;

const LONG_REPLY = Array.from(
  { length: 300 },
  (_, i) => `${i + 1}. Line ${i + 1} of a long reply: type while it streams; the keys must still appear at once.`,
).join("\n");

const HELP = [
  bold("Dovet tui-demo (SPIKE-4)"),
  dim("Enter sends · Shift+Enter or Alt+Enter: new line · Ctrl+O: overlay · Esc: close overlay · Ctrl+C: quit"),
  dim("/long streams 300 lines · /reply streams the sample again · resize the window while a reply streams"),
].join("\n");

/** Dovet's own colors (tui "Rendering rules": Dovet paints its own background, QUESTIONS Q8). */
type Palette = { name: "dark" | "light"; bg: Color; fg: Color; overlay: Color };
const DARK: Palette = {
  name: "dark",
  bg: rgbColor(24, 25, 33),
  fg: rgbColor(222, 223, 230),
  overlay: rgbColor(44, 46, 60),
};
const LIGHT: Palette = {
  name: "light",
  bg: rgbColor(250, 249, 245),
  fg: rgbColor(36, 37, 46),
  overlay: rgbColor(232, 230, 222),
};

/**
 * Paint one line with the palette across `width` columns. Every reset inside the line (SGR 0, 39, 49) is followed by
 * the palette again, so no text falls back to the terminal's own colors mid-line.
 */
export function paintLine(line: string, width: number, bg: Color, fg: Color): string {
  const mode = getTerminalColorMode();
  const bgOn = backgroundAnsi(bg, mode);
  const fgOn = foregroundAnsi(fg, mode);
  const body = line
    .replaceAll("\x1b[0m", `\x1b[0m${fgOn}${bgOn}`)
    .replaceAll("\x1b[m", `\x1b[m${fgOn}${bgOn}`)
    .replaceAll("\x1b[39m", `\x1b[39m${fgOn}`)
    .replaceAll("\x1b[49m", `\x1b[49m${bgOn}`);
  return `${fgOn}${bgOn}${body}${" ".repeat(Math.max(0, width - visibleWidth(line)))}\x1b[0m`;
}

/** Wraps the whole screen so every line Dovet draws is painted (inline mode: full width, blank lines too). */
class Painted implements Component {
  constructor(
    private readonly child: Component,
    private readonly palette: () => Palette | undefined,
  ) {}
  invalidate(): void {
    this.child.invalidate();
  }
  render(width: number): string[] {
    const p = this.palette();
    const lines = this.child.render(width);
    return p ? lines.map((line) => paintLine(line, width, p.bg, p.fg)) : lines;
  }
}

type Probe = { colors: string; lastKey: string; theme: string };

/** One line of facts for the checklist: size, keyboard protocol, theme colors, redraws and the last key received. */
class StatusLine {
  constructor(
    private readonly tui: TUI,
    private readonly probe: Probe,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const t = this.tui.terminal;
    const facts = [
      `last key: ${this.probe.lastKey}`,
      `${t.columns}x${t.rows}`,
      `kitty keys: ${t.kittyProtocolActive ? "on" : "off"}`,
      `terminal colors: ${this.probe.colors}`,
      `Dovet theme: ${this.probe.theme}`,
      `full redraws: ${this.tui.fullRedraws}`,
    ];
    return [truncateToWidth(dim(facts.join(" · ")), width)];
  }
}

function describeColors(colors: TerminalColors): string {
  const hex = (c: { r: number; g: number; b: number }) =>
    `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  if (!colors.background) return "not reported";
  const { r, g, b } = colors.background;
  const scheme = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
  return `${scheme} background ${hex(colors.background)}`;
}

type Demo = {
  tui: TUI;
  editor: Editor;
  /** Start rendering, ask the terminal for its colors, then make Dovet's colors the terminal's defaults. */
  start(): void;
  /** Give the terminal its own default colors back (every way out). */
  restoreTerminalDefaults(): void;
  /** Start streaming `text` as a new reply; calls `onDone` when it's complete. */
  stream(text: string, onDone?: () => void): void;
  toggleOverlay(): void;
};

/** Build the demo screen on `terminal`. `chunk` characters arrive every `intervalMs`. */
function createDemo(
  terminal: Terminal,
  opts: { alt: boolean; chunk: number; intervalMs: number; noColor: boolean },
): Demo {
  const tui: TUI = opts.alt ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  // The hardware cursor follows the caret, so IME composition windows appear in place (tui "Terminal I/O robustness").
  tui.setShowHardwareCursor(true);
  // NO_COLOR, or a terminal without 256 colors: no background is painted.
  const painting = !opts.noColor;
  let palette: Palette | undefined = painting ? DARK : undefined;
  const probe: Probe = { colors: "asking…", lastKey: "(none yet)", theme: palette?.name ?? "off (NO_COLOR)" };
  const transcript = new Container();
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const screen = new Container();
  screen.addChild(new Text(HELP, 1, 0));
  screen.addChild(transcript);
  screen.addChild(new StatusLine(tui, probe));
  screen.addChild(editor);
  tui.addChild(new Painted(screen, () => palette));
  tui.setFocus(editor);

  let streaming: ReturnType<typeof setInterval> | undefined;
  const stream = (text: string, onDone?: () => void) => {
    if (streaming) clearInterval(streaming);
    const reply = new Markdown("", 1, 1, markdownTheme);
    transcript.addChild(reply);
    const chars = Array.from(text); // whole code points, like a model's text deltas
    let shown = 0;
    const step = () => {
      shown = Math.min(chars.length, shown + opts.chunk);
      reply.setText(chars.slice(0, shown).join(""));
      tui.requestRender();
      if (shown === chars.length) {
        if (streaming) clearInterval(streaming);
        streaming = undefined;
        onDone?.();
      }
    };
    if (opts.intervalMs <= 0) {
      while (shown < chars.length) {
        step();
        tui.renderNow();
      }
      return;
    }
    streaming = setInterval(step, opts.intervalMs);
  };

  let overlay: OverlayHandle | undefined;
  const toggleOverlay = () => {
    if (overlay) {
      overlay.hide();
      overlay = undefined;
      tui.setFocus(editor);
    } else {
      const shade = palette;
      const box = new Box(
        2,
        1,
        shade ? (line) => paintLine(line, visibleWidth(line), shade.overlay, shade.fg) : undefined,
      );
      box.addChild(
        new Text(`${bold("This is an overlay")}\n\nIt is drawn over the conversation.\nEsc or Ctrl+O closes it.`, 0, 0),
      );
      overlay = tui.showOverlay(box, { width: 44 });
    }
    tui.requestRender();
  };

  editor.onSubmit = (value) => {
    const text = value.trim();
    if (!text) return;
    editor.addToHistory(text);
    transcript.addChild(new Text(`${bold("You:")} ${text}`, 1, 0));
    if (text === "/long") stream(LONG_REPLY);
    else if (text === "/reply") stream(SAMPLE_REPLY);
    else stream(`You wrote:\n\n> ${text.split("\n").join("\n> ")}\n\n${SAMPLE_REPLY}`);
  };

  tui.addInputListener((data) => {
    probe.lastKey = `${JSON.stringify(data)}${parseKey(data) ? ` = ${parseKey(data)}` : ""}`;
    tui.requestRender();
    if (overlay && (matchesKey(data, "escape") || matchesKey(data, "ctrl+o"))) {
      toggleOverlay();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      toggleOverlay();
      return { consume: true };
    }
    return undefined;
  });

  // While Dovet runs, the terminal's own default colors are Dovet's (OSC 11 background, OSC 10 text), so the whole
  // window matches: empty rows, the right edge and the window padding too, not only the lines Dovet draws (owner's
  // second GNOME Terminal run). OSC 110/111 give the terminal its configured colors back.
  const setTerminalDefaults = () => {
    if (palette) terminal.write(`\x1b]11;${colorToHex(palette.bg)}\x07\x1b]10;${colorToHex(palette.fg)}\x07`);
  };
  const restoreTerminalDefaults = () => {
    if (painting) terminal.write("\x1b]110\x07\x1b]111\x07");
  };

  // Ask for the theme colors only once pi-tui owns the terminal (raw mode, its input parser): asked earlier, the
  // terminal's reply is echoed onto the screen (owner's GNOME Terminal run, SPIKE-4). Dovet's defaults are set only
  // after the reply, or the question would return Dovet's own colors.
  const start = () => {
    tui.start();
    tui
      .queryTerminalColors({ timeoutMs: 500, onLateReply: (c) => (probe.colors = `${describeColors(c)} (late)`) })
      .then((c) => {
        probe.colors = describeColors(c);
        // The terminal's light/dark only picks which of Dovet's variants starts.
        if (painting && describeColors(c).startsWith("light")) palette = LIGHT;
        probe.theme = palette?.name ?? probe.theme;
      })
      .catch((error: unknown) => {
        probe.colors = `query failed: ${String(error)}`;
      })
      .finally(() => {
        setTerminalDefaults();
        tui.requestRender(true);
      });
  };

  return { tui, editor, start, restoreTerminalDefaults, stream, toggleOverlay };
}

/** A terminal that records what pi-tui writes, for `--self-test` (no TTY in CI). */
class MemoryTerminal implements Terminal {
  output = "";
  readonly columns = 80;
  readonly rows = 40;
  readonly kittyProtocolActive = false;
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(lines: number): void {
    if (lines > 0) this.output += `\x1b[${lines}B`;
    else if (lines < 0) this.output += `\x1b[${-lines}A`;
  }
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}

async function selfTest(): Promise<void> {
  const terminal = new MemoryTerminal();
  const demo = createDemo(terminal, { alt: false, chunk: 40, intervalMs: 0, noColor: false });
  demo.start();
  demo.stream(SAMPLE_REPLY);
  demo.editor.setText("typed into the editor");
  demo.toggleOverlay();
  demo.tui.renderNow();
  demo.tui.stop();
  const synchronized = terminal.output.includes("\x1b[?2026h") && terminal.output.includes("\x1b[?2026l");
  process.stdout.write(
    `${stripTerminalSequences(terminal.output)}\nframes synchronized: ${synchronized ? "yes" : "no"}\n`,
  );
  // The kernel32 call that replaces pi-tui's Windows addon, run inside the compiled binary (stdin is not a console here).
  if (process.platform === "win32") process.stdout.write(`vt input enabled: ${enableWindowsVirtualTerminalInput()}\n`);
}

async function interactive(alt: boolean): Promise<void> {
  const terminal = new ProcessTerminal();
  const demo = createDemo(terminal, { alt, chunk: 6, intervalMs: 16, noColor: Boolean(process.env.NO_COLOR) });
  // The terminal's own colors come back on every way out, a crash included.
  process.on("exit", () => demo.restoreTerminalDefaults());
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => void quit());
  const quit = async () => {
    demo.restoreTerminalDefaults();
    demo.tui.stop();
    await terminal.drainInput();
    process.exit(0);
  };
  demo.tui.addInputListener((data) => {
    if (!matchesKey(data, "ctrl+c")) return undefined;
    void quit();
    return { consume: true };
  });
  demo.start();
  demo.stream(SAMPLE_REPLY);
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) await selfTest();
else await interactive(args.includes("--alt"));
