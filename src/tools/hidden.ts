// Hidden-instruction characters never reach the model (permissions §10): tag characters, the variation-selector supplement, word-joiner and deprecated format controls. ZWJ, ZWNJ, U+FE0F and bidi controls stay.
const HIDDEN = /(?:[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]|[\u2060-\u2064\u206A-\u206F])+/gu;

export function stripHidden(line: string): { text: string; removed: number } {
  let removed = 0;
  const text = line.replace(HIDDEN, (run) => {
    const count = [...run].length;
    removed += count;
    return `⟨${count} hidden characters removed⟩`;
  });
  return { text, removed };
}
