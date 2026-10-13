// Prompt files are embedded with `with { type: "text" }` (architecture "Prompts have one home").
declare module "*.md" {
  const text: string;
  export default text;
}
