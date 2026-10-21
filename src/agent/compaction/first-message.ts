// The first message of a compacted epoch (context §6 "Shape"): the user's words, the summary, the Dovet facts.
import { CHARS_PER_TOKEN } from "../budgets/estimate.ts";
import { escapeReservedMarkers } from "../transcript/markers.ts";

/** `min(32,000 tokens, 10% of the context window)`. */
export function retainBudget(window: number): number {
  return Math.min(32_000, Math.floor(window * 0.1));
}

/** The last `chars` code units of `text`, never starting inside a surrogate pair. */
function tailOf(text: string, chars: number): string {
  let from = text.length - chars;
  const unit = text.charCodeAt(from);
  if (unit >= 0xdc00 && unit <= 0xdfff) from += 1;
  return text.slice(from);
}

/** Newest messages that fit `budgetTokens`, oldest first; older ones are dropped whole, never reworded. */
export function retainUserMessages(all: readonly string[], budgetTokens: number): { kept: string[]; omitted: number } {
  const limit = Math.floor(budgetTokens * CHARS_PER_TOKEN);
  const kept: string[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const text = all[i] ?? "";
    if (used + text.length > limit) {
      if (kept.length === 0) {
        const tail = tailOf(text, limit);
        kept.push(`[the first ${text.length - tail.length} characters of this message were left out]\n${tail}`);
        return { kept, omitted: all.length - 1 };
      }
      return { kept: kept.reverse(), omitted: i + 1 };
    }
    kept.push(text);
    used += text.length;
  }
  return { kept: kept.reverse(), omitted: 0 };
}

const NO_SUMMARY =
  "No summary was written (the summary request failed). The messages above and the facts below are all that was kept.";

export function renderFirstMessage(args: {
  kept: readonly string[];
  omitted: number;
  summary: string | null;
  facts: string;
}): string {
  const out = ["# Your earlier messages (verbatim)", ""];
  if (args.omitted > 0)
    out.push(
      `[${args.omitted} earlier ${args.omitted === 1 ? "message was" : "messages were"} left out: together they were over the size limit for this section.]`,
      "",
    );
  for (const [i, text] of args.kept.entries()) out.push(`--- message ${i + 1} ---`, text, "");
  out.push(
    "# Summary of the earlier work",
    "",
    args.summary === null ? NO_SUMMARY : escapeReservedMarkers(args.summary.trim()),
    "",
    "# Facts recorded by Dovet",
    "",
    escapeReservedMarkers(args.facts),
  );
  return out.join("\n");
}
