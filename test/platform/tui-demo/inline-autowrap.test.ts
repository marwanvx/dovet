// SPIKE-4 finding (GNOME Terminal, owner run 2026-10-12): a terminal that draws a character wider than pi-tui measures
// it (👍🏽 as two glyphs) wraps pi-tui's full-width padded line onto the next row, and every inline redraw then lands one
// row lower, leaving stale copies above. The inline renderer must turn the terminal's auto-wrap off while it draws,
// as pi-tui's fullscreen renderer already does, so an over-wide line is clipped instead of shifting the screen.
import { expect, test } from "bun:test";
import { type ProgramStatus, type Terminal, Text, TuiMainScreen } from "../../../src/tui/vendor/pi-tui/index.ts";

class RecordingTerminal implements Terminal {
  writes: string[] = [];
  readonly columns = 40;
  readonly rows = 10;
  readonly kittyProtocolActive = false;
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}

test("every inline frame is drawn with auto-wrap off and turns it back on", () => {
  const terminal = new RecordingTerminal();
  const tui = new TuiMainScreen(terminal);
  const text = new Text("first", 1, 0);
  tui.addChild(text);
  tui.start();
  tui.renderNow(); // first frame (full render)
  text.setText("first 👍🏽");
  tui.renderNow(); // differential frame
  tui.addChild(new Text("second line", 1, 0));
  tui.renderNow(); // appended lines
  tui.stop();

  const output = terminal.writes.join("");
  const frames = output.split("\x1b[?2026h").slice(1);
  expect(frames.length).toBeGreaterThanOrEqual(3);
  for (const frame of frames) {
    const body = frame.slice(0, frame.indexOf("\x1b[?2026l"));
    expect(body.startsWith("\x1b[?7l")).toBe(true);
    expect(body.endsWith("\x1b[?7h")).toBe(true);
  }
});
