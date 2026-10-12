// `tui-demo`: the SPIKE-4 test program (docs/plan/open-questions.md). Not part of the `dovet` command.
// It drives the vendored pi-tui core (src/tui/vendor/pi-tui, no native addons) the way Dovet will: a reply streamed as
// markdown, an input editor, an overlay and a status line that shows what the terminal sent and answered.
//
//     bun scripts/tui-demo.ts               # inline mode (keeps the terminal's scrollback), like Dovet's default
//     bun scripts/tui-demo.ts --alt         # fullscreen (alternate screen)
//     bun scripts/tui-demo.ts --self-test   # no terminal needed: renders into memory and prints what was drawn
//     bun scripts/tui-demo.ts --build <out> # compile the demo into a single executable
//
// CI compiles it per OS and attaches it to the run (ci.yml, "tui-demo" artifacts) for the owner's terminal checklist.
import { join } from "node:path";
import {
  Box,
  Container,
  Editor,
  type EditorTheme,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  type ProgramStatus,
  parseKey,
  type SelectListTheme,
  stripTerminalSequences,
  type Terminal,
  type TerminalColors,
  Text,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  truncateToWidth,
} from "../src/tui/vendor/pi-tui/index.ts";
import { compileDovet } from "./build.ts";

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
export const SAMPLE_REPLY = `# Streaming markdown

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

type Probe = { colors: string; lastKey: string };

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
      `colors: ${this.probe.colors}`,
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

export type Demo = {
  tui: TUI;
  /** Start streaming `text` as a new reply; calls `onDone` when it's complete. */
  stream(text: string, onDone?: () => void): void;
  toggleOverlay(): void;
};

/** Build the demo screen on `terminal`. `chunk` characters arrive every `intervalMs`. */
export function createDemo(terminal: Terminal, opts: { alt: boolean; chunk: number; intervalMs: number }): Demo {
  const tui: TUI = opts.alt ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  // The hardware cursor follows the caret, so IME composition windows appear in place (tui "Terminal I/O robustness").
  tui.setShowHardwareCursor(true);
  const probe: Probe = { colors: "asking…", lastKey: "(none yet)" };
  const transcript = new Container();
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  tui.addChild(new Text(HELP, 1, 0));
  tui.addChild(transcript);
  tui.addChild(new StatusLine(tui, probe));
  tui.addChild(editor);
  tui.setFocus(editor);

  let streaming: ReturnType<typeof setInterval> | undefined;
  const stream = (text: string, onDone?: () => void) => {
    if (streaming) clearInterval(streaming);
    const reply = new Markdown("", 1, 1, markdownTheme);
    transcript.addChild(reply);
    let shown = 0;
    const step = () => {
      shown = Math.min(text.length, shown + opts.chunk);
      reply.setText(text.slice(0, shown));
      tui.requestRender();
      if (shown === text.length) {
        if (streaming) clearInterval(streaming);
        streaming = undefined;
        onDone?.();
      }
    };
    if (opts.intervalMs <= 0) {
      while (shown < text.length) {
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
      const box = new Box(2, 1);
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

  tui
    .queryTerminalColors({ timeoutMs: 500, onLateReply: (c) => (probe.colors = `${describeColors(c)} (late)`) })
    .then((c) => {
      probe.colors = describeColors(c);
      tui.requestRender();
    })
    .catch((error: unknown) => {
      probe.colors = `query failed: ${String(error)}`;
    });

  return { tui, stream, toggleOverlay };
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
  const demo = createDemo(terminal, { alt: false, chunk: 40, intervalMs: 0 });
  demo.tui.start();
  demo.stream(SAMPLE_REPLY);
  demo.toggleOverlay();
  demo.tui.renderNow();
  demo.tui.stop();
  const synchronized = terminal.output.includes("\x1b[?2026h") && terminal.output.includes("\x1b[?2026l");
  process.stdout.write(
    `${stripTerminalSequences(terminal.output)}\nframes synchronized: ${synchronized ? "yes" : "no"}\n`,
  );
}

async function interactive(alt: boolean): Promise<void> {
  const terminal = new ProcessTerminal();
  const demo = createDemo(terminal, { alt, chunk: 6, intervalMs: 16 });
  const quit = async () => {
    demo.tui.stop();
    await terminal.drainInput();
    process.exit(0);
  };
  demo.tui.addInputListener((data) => {
    if (!matchesKey(data, "ctrl+c")) return undefined;
    void quit();
    return { consume: true };
  });
  demo.tui.start();
  demo.stream(SAMPLE_REPLY);
}

/** Compile the demo with Dovet's own compile options (build.ts). */
export async function compileTuiDemo(opts: { outfile: string }): Promise<void> {
  await compileDovet({ entry: join(import.meta.dir, "tui-demo.ts"), outfile: opts.outfile });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--build" && args[1]) await compileTuiDemo({ outfile: args[1] });
  else if (args.includes("--self-test")) await selfTest();
  else await interactive(args.includes("--alt"));
}
