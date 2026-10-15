import { describe, expect, test } from "bun:test";
import { context, text } from "./test-context.ts";
import { createTodoWriteTool } from "./todos.ts";

const todo = createTodoWriteTool();

describe("TodoWrite", () => {
  // spec: AC-TOOLS-45
  test("two in_progress items are rejected with the rule named", async () => {
    const ctx = context("/tmp");
    const out = await todo.run(
      {
        todos: [
          { content: "First", activeForm: "Firsting", status: "in_progress" },
          { content: "Second", activeForm: "Seconding", status: "in_progress" },
        ],
      },
      ctx,
    );
    expect(out.status).toBe("error");
    expect(text(out)).toContain("in_progress");
  });

  test("result counts completed without echoing the list", async () => {
    const ctx = context("/tmp");
    const out = await todo.run(
      {
        todos: [
          { content: "A", activeForm: "Aing", status: "completed" },
          { content: "B", activeForm: "Bing", status: "in_progress" },
          { content: "C", activeForm: "Cing", status: "pending" },
        ],
      },
      ctx,
    );
    expect(out.status).toBe("ok");
    expect(text(out)).toBe("Task list updated (1/3 completed).");
  });

  test("not parallel-safe and needs no permission", () => {
    expect(todo.parallelSafe).toBe(false);
    expect(todo.describeAction({ todos: [] }, context("/tmp")).kind).toBe("task-list");
  });

  test("at most 50 items and 200 chars per text", async () => {
    const { createToolRegistry } = await import("./index.ts");
    const many = {
      todos: Array.from({ length: 51 }, (_, i) => ({
        content: `T${i}`,
        activeForm: "Doing",
        status: "pending" as const,
      })),
    };
    expect(createToolRegistry([todo]).prepare("TodoWrite", many).ok).toBe(false);
    const long = { todos: [{ content: "x".repeat(201), activeForm: "Doing", status: "pending" as const }] };
    expect(createToolRegistry([todo]).prepare("TodoWrite", long).ok).toBe(false);
  });
});
