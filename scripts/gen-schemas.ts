// Writes the published JSON Schemas from the zod schemas (architecture "Repository layout": schema/). `--check` fails if a file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Settings } from "../src/schema/index.ts";

const ROOT = join(import.meta.dir, "..");

export function schemaFiles(): Record<string, string> {
  const settings = z.toJSONSchema(Settings, { io: "input", target: "draft-7" });
  return { "schema/settings.schema.json": `${JSON.stringify({ title: "Dovet settings", ...settings }, null, 2)}\n` };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [file, text] of Object.entries(schemaFiles())) {
    const path = join(ROOT, file);
    const current = (() => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    })();
    if (current === text) continue;
    if (check) {
      console.error(`${file} is out of date; run \`bun run gen:schemas\``);
      stale = true;
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${file}`);
    }
  }
  if (stale) process.exit(1);
}
