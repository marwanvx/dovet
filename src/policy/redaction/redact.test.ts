// Secret redaction (permissions §8): values, key formats and URL passwords never reach the model or the log.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempProject } from "../../../test/helpers/index.ts";
import { redactText } from "./redact.ts";
import { createDotEnvSecrets, type NamedSecret, secretsFromEnv } from "./secrets.ts";

const CORPUS = new URL("../testdata/redaction-corpus.jsonl", import.meta.url);

async function corpus(): Promise<
  Array<{ id: string; secrets: Record<string, string>; input: string; expected: string }>
> {
  const lines = (await Bun.file(CORPUS).text()).trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

// spec: AC-PERM-30
describe("redaction corpus", () => {
  test("every corpus case redacts to exactly its expected text", async () => {
    for (const c of await corpus()) {
      const secrets: NamedSecret[] = Object.entries(c.secrets).map(([name, value]) => ({ name, value }));
      expect(redactText(c.input, secrets), c.id).toBe(c.expected);
    }
  });

  test("no corpus output leaks the input secret material", async () => {
    for (const c of await corpus()) {
      const out = redactText(
        c.input,
        Object.entries(c.secrets).map(([name, value]) => ({ name, value })),
      );
      if (out === c.input) continue;
      for (const value of Object.values(c.secrets)) {
        if (value.length >= 8) expect(out, c.id).not.toContain(value);
      }
    }
  });
});

// spec: AC-PERM-30
describe("secret values", () => {
  test("secret-named env vars join the set; short values and ordinary vars do not", () => {
    const found = secretsFromEnv({
      GITHUB_TOKEN: "ghp_examplefake0000000000000000000001",
      DB_PASSWORD: "correct-horse-battery-9",
      SHORT_KEY: "abc123",
      EDITOR: "vim",
      PATH: "/usr/bin",
    });
    expect(found.map((s) => s.name).sort()).toEqual(["DB_PASSWORD", "GITHUB_TOKEN"]);
    expect(redactText("uses ghp_examplefake0000000000000000000001 and abc123", found)).toBe(
      "uses [REDACTED:GITHUB_TOKEN] and abc123",
    );
  });
});

// spec: AC-PERM-30
describe("workspace .env values", () => {
  test(".env and .env.local values join the set; templates are ignored and edits are picked up", async () => {
    const project = await tempProject({
      ".env": 'DB_PASSWORD="correct-horse-battery-9"\nPORT=3000\n',
      ".env.local": "STRIPE_SECRET_KEY=rk-live-example-0001-fakevalue\n",
      ".env.example": "DB_PASSWORD=changeme\n",
    });
    try {
      const loader = createDotEnvSecrets([project.root]);
      const first = loader.current();
      expect(first.map((s) => s.name).sort()).toEqual(["DB_PASSWORD", "STRIPE_SECRET_KEY"]);
      expect(redactText("pw correct-horse-battery-9 port 3000", first)).toBe("pw [REDACTED:DB_PASSWORD] port 3000");
      await Bun.write(join(project.root, ".env"), 'DB_PASSWORD="rotated-horse-battery-10"\nPORT=3000\n');
      const second = loader.current();
      expect(second.map((s) => s.name).sort()).toEqual(["DB_PASSWORD", "STRIPE_SECRET_KEY"]);
      expect(redactText("pw rotated-horse-battery-10", second)).toBe("pw [REDACTED:DB_PASSWORD]");
    } finally {
      await project.dispose();
    }
  });
});
