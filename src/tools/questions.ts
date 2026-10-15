// AskUserQuestion (tools §4): multiple-choice questions for decisions only the user can make.
import { z } from "zod";
import type { AskUserQuestionInput, QuestionAnswers, ToolContext, ToolDefinition, ToolOutput } from "./types.ts";
import { NoUserAvailable } from "./types.ts";

export { NoUserAvailable };
export const NO_USER_TEXT =
  "No user is available to answer. Proceed with your best judgment and state your assumption.";
export const DISMISSED_TEXT = "The user dismissed the questions without answering.";

const OptionInput = z.strictObject({
  label: z.string().min(1),
  description: z.string().min(1),
  preview: z.string().optional(),
});

const QuestionInput = z.strictObject({
  question: z.string().min(1),
  header: z.string().min(1),
  options: z.array(OptionInput).min(2).max(4),
  multiSelect: z.boolean(),
});

const AskInput = z.strictObject({
  questions: z.array(QuestionInput).min(1).max(4),
});
type AskInput = z.infer<typeof AskInput>;

const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });
const ok = (text: string): ToolOutput => ({ status: "ok", content: [{ kind: "text", text }] });

function dropOther(options: AskInput["questions"][number]["options"]): typeof options {
  return options.filter((o) => o.label.toLowerCase() !== "other");
}

export function normalizeQuestions(input: AskInput): AskInput {
  return {
    questions: input.questions.map((q) => ({ ...q, options: dropOther(q.options) })),
  };
}

export function questionErrors(input: AskInput): string | undefined {
  for (const q of input.questions) {
    if (q.options.length === 0) return "questions[].options: at least one option is required";
    const seen = new Set<string>();
    for (const o of q.options) {
      if (seen.has(o.label)) return `questions[].options: duplicate label "${o.label}"`;
      seen.add(o.label);
    }
  }
  return undefined;
}

export function truncateHeader(header: string): string {
  return header.length > 12 ? `${header.slice(0, 11)}…` : header;
}

export function formatQuestionResult(input: AskUserQuestionInput, answers: QuestionAnswers): string {
  if ("dismissed" in answers) return DISMISSED_TEXT;
  const lines: string[] = [];
  input.questions.forEach((q, i) => {
    const a = answers.answers[i];
    if (a === undefined) return;
    const parts: string[] = [...a.selected];
    if (a.other !== undefined) parts.push(`Other: "${a.other}"`);
    lines.push(`"${q.question}" → ${parts.join(", ")}`);
    for (const n of a.notes) lines.push(`Note on "${n.label}": ${n.text}`);
  });
  return lines.join("\n");
}

export function createAskQuestionTool(): ToolDefinition<AskInput> {
  async function run(input: AskInput, ctx: ToolContext): Promise<ToolOutput> {
    const normalized = normalizeQuestions(input);
    const problem = questionErrors(normalized);
    if (problem !== undefined) return fail(`Invalid input for AskUserQuestion: ${problem}`);
    if (ctx.session.mode === "dontAsk") return fail(NO_USER_TEXT);
    const interact = ctx.interact;
    if (interact === undefined) return fail(NO_USER_TEXT);
    let answers: QuestionAnswers;
    try {
      answers = await interact.askQuestions(normalized, ctx.signal);
    } catch (e) {
      if (e instanceof NoUserAvailable) return fail(NO_USER_TEXT);
      throw e;
    }
    return ok(formatQuestionResult(normalized, answers));
  }

  return {
    name: "AskUserQuestion",
    input: AskInput,
    descriptionFile: "tools/AskUserQuestion.md",
    errorExample: {
      questions: [
        {
          question: "Which runtime should we target?",
          header: "Runtime",
          options: [
            { label: "Bun", description: "Fast startup, built-in bundling" },
            { label: "Node", description: "Widest compatibility" },
          ],
          multiSelect: false,
        },
      ],
    },
    parallelSafe: false,
    mutates: "none",
    describeAction(_input, _ctx) {
      return {
        kind: "interaction",
        effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
      };
    },
    run,
  };
}

export const askQuestionTool = createAskQuestionTool();
