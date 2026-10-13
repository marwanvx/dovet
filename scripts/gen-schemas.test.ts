import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schemaFiles } from "./gen-schemas.ts";

test("the committed JSON Schemas match the zod schemas", () => {
  for (const [file, text] of Object.entries(schemaFiles())) {
    expect(readFileSync(join(import.meta.dir, "..", file), "utf8"), `${file} is stale: run bun run gen:schemas`).toBe(
      text,
    );
  }
});

test("the settings schema names every top-level key and rejects unknown ones", () => {
  const schema = JSON.parse(schemaFiles()["schema/settings.schema.json"] ?? "{}") as {
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  expect(Object.keys(schema.properties)).toEqual(
    expect.arrayContaining(["$schema", "permissions", "sandbox", "providers", "ui"]),
  );
  expect(schema.additionalProperties).toBe(false);
});
