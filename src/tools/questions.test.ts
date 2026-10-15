import { describe, expect, test } from "bun:test";
import {
  createAskQuestionTool,
  DISMISSED_TEXT,
  formatQuestionResult,
  NO_USER_TEXT,
  normalizeQuestions,
  questionErrors,
  truncateHeader,
} from "./questions.ts";
import { context, text } from "./test-context.ts";

const ask = createAskQuestionTool();

describe("AskUserQuestion validation", () => {
  // spec: AC-TOOLS-50
  test("5 questions are rejected with the field named", async () => {
    const input = {
      questions: Array.from({ length: 5 }, (_, i) => ({
        question: `Q${i}?`,
        header: `H${i}`,
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ],
        multiSelect: false,
      })),
    };
    const prepared = (await import("./index.ts")).createToolRegistry([ask]).prepare("AskUserQuestion", input);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.message).toContain("questions");
  });

  // spec: AC-TOOLS-50
  test("5 options are rejected with the field named", async () => {
    const { createToolRegistry } = await import("./index.ts");
    const input = {
      questions: [
        {
          question: "Which?",
          header: "Pick",
          options: Array.from({ length: 5 }, (_, i) => ({ label: `O${i}`, description: "d" })),
          multiSelect: false,
        },
      ],
    };
    const prepared = createToolRegistry([ask]).prepare("AskUserQuestion", input);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.message).toContain("options");
  });

  // spec: AC-TOOLS-50
  test("dontAsk returns the no-user error", async () => {
    const ctx = context("/tmp", {
      session: {
        id: "s",
        cwd: "/tmp" as never,
        workingDirs: ["/tmp" as never],
        mode: "dontAsk",
        taint: [],
        interactive: true,
      },
      interact: {
        askQuestions: () => Promise.resolve({ answers: [{ selected: ["A"], notes: [] }] }),
        presentPlan: () => Promise.reject(new Error("unused")),
      },
    });
    const out = await ask.run(
      {
        questions: [
          {
            question: "Which?",
            header: "Pick",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
            multiSelect: false,
          },
        ],
      },
      ctx,
    );
    expect(out.status).toBe("error");
    expect(text(out)).toBe(NO_USER_TEXT);
  });

  test("an option labeled Other is dropped and duplicates error", () => {
    const withOther = normalizeQuestions({
      questions: [
        {
          question: "Q?",
          header: "H",
          options: [
            { label: "A", description: "a" },
            { label: "Other", description: "own" },
            { label: "OTHER", description: "own2" },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(withOther.questions[0]?.options.map((o) => o.label)).toEqual(["A"]);
    const dup = normalizeQuestions({
      questions: [
        {
          question: "Q?",
          header: "H",
          options: [
            { label: "A", description: "a" },
            { label: "A", description: "b" },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(questionErrors(dup)).toContain("duplicate");
    expect(questionErrors({ questions: [] } as never)).toBeUndefined();
  });

  test("a header over 12 chars is cut with an ellipsis, not rejected", () => {
    expect(truncateHeader("1234567890123")).toBe("12345678901…");
    expect(truncateHeader("short")).toBe("short");
  });

  test("result lines join labels, Other text and notes with no continue instruction", () => {
    const input = {
      questions: [
        {
          question: "Which?",
          header: "Pick",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
          multiSelect: true,
        },
      ],
    };
    const out = formatQuestionResult(input, {
      answers: [{ selected: ["A", "B"], other: "custom", notes: [{ label: "A", text: "why" }] }],
    });
    expect(out).toContain('"Which?" → A, B, Other: "custom"');
    expect(out).toContain('Note on "A": why');
    expect(out).not.toContain("continue");
    expect(formatQuestionResult(input, { dismissed: true })).toBe(DISMISSED_TEXT);
  });

  test("never parallel and describes as interaction", () => {
    expect(ask.parallelSafe).toBe(false);
    expect(ask.describeAction({ questions: [] } as never, context("/tmp")).kind).toBe("interaction");
  });

  test("run drops a model-labeled Other before asking", async () => {
    let seen: { questions: Array<{ options: Array<{ label: string }> }> } | undefined;
    const ctx = context("/tmp", {
      session: {
        id: "s",
        cwd: "/tmp" as never,
        workingDirs: ["/tmp" as never],
        mode: "default",
        taint: [],
        interactive: true,
      },
      interact: {
        askQuestions: (q) => {
          seen = q as typeof seen;
          return Promise.resolve({ answers: [{ selected: ["A"], notes: [] }] });
        },
        presentPlan: () => Promise.reject(new Error("unused")),
      },
    });
    const out = await ask.run(
      {
        questions: [
          {
            question: "Q?",
            header: "H",
            options: [
              { label: "A", description: "a" },
              { label: "Other", description: "own" },
            ],
            multiSelect: false,
          },
        ],
      },
      ctx,
    );
    expect(out.status).toBe("ok");
    expect(seen?.questions[0]?.options.map((o) => o.label)).toEqual(["A"]);
  });
});
