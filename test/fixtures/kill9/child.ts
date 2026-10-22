// A headless session that writes many large files, killed by its parent at a random moment (test/adversarial/kill9.test.ts).
import { hostname } from "node:os";
import { type Call, runIn, scripted } from "../../adversarial/harness.ts";
import { fileContent } from "./content.ts";

const root = process.argv[2] ?? "";
const STEPS = 30;
const write = (step: number): Call[] => [
  { name: "Write", input: { file_path: `${root}/out/f${step % 5}.txt`, content: fileContent(step % 5, step) } },
];

let announced = false;
const adapter = scripted([...Array.from({ length: STEPS }, (_, i) => write(i)), []], () => {
  if (announced) return;
  announced = true;
  process.stdout.write("READY\n");
}, 120);
const out = await runIn(root, { adapter, mode: "acceptEdits", prompt: "write the files",
  pid: process.pid,
  host: hostname(), settings: { budget: { daily: 5 } } });
process.stdout.write(`DONE ${JSON.stringify(out.exit)}\n`);
