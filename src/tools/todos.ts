// TodoWrite (tools §12): the task list the model keeps for multi-step work.
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.ts";

const TodoItem = z.strictObject({
  content: z.string().min(1).max(200),
  activeForm: z.string().min(1).max(200),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const TodoInput = z.strictObject({
  todos: z.array(TodoItem).max(50),
});
type TodoInput = z.infer<typeof TodoInput>;

const fail = (text: string): ToolOutput => ({ status: "error", content: [{ kind: "text", text }] });

export function todoSummary(todos: TodoInput["todos"]): string {
  const done = todos.filter((t) => t.status === "completed").length;
  return `Task list updated (${done}/${todos.length} completed).`;
}

export function createTodoWriteTool(): ToolDefinition<TodoInput> {
  async function run(input: TodoInput, _ctx: ToolContext): Promise<ToolOutput> {
    const active = input.todos.filter((t) => t.status === "in_progress").length;
    if (active > 1)
      return fail(`Invalid input for TodoWrite: at most one item may be "in_progress" (found ${active}).`);
    return { status: "ok", content: [{ kind: "text", text: todoSummary(input.todos) }] };
  }

  return {
    name: "TodoWrite",
    input: TodoInput,
    descriptionFile: "tools/TodoWrite.md",
    errorExample: {
      todos: [{ content: "Add retry to the upload client", activeForm: "Adding retry", status: "in_progress" }],
    },
    parallelSafe: false,
    mutates: "none",
    describeAction(_input, _ctx) {
      return {
        kind: "task-list",
        effects: { writes: "none", network: "none", sensitiveReads: [], remote: [], sandboxed: false },
      };
    },
    run,
  };
}

export const todoWriteTool = createTodoWriteTool();
