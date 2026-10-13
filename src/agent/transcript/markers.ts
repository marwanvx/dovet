// Reserved markers can't be forged (context §4): Dovet's markers in content it didn't write are made visibly different.
// ASSUMPTION (QUESTIONS Q29): the escaped forms.
const GAP = "[\\s\\u200B-\\u200F\\u2060-\\u2064\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]";
const INSTRUCTION = new RegExp(`\\[(${GAP}*dovet${GAP}+instruction${GAP}*)\\]`, "gi");
const LABEL = new RegExp(`▸(${GAP}*dovet${GAP}*:)`, "gi");
const TAG = new RegExp(`<(${GAP}*/?${GAP}*dovet-)`, "gi");

export function escapeReservedMarkers(text: string): string {
  return text.replace(INSTRUCTION, "［$1］").replace(LABEL, "▹$1").replace(TAG, "‹$1");
}
