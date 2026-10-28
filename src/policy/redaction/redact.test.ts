// Secret redaction (permissions §8): values, key formats and URL passwords never reach the model or the log.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempProject } from "../../../test/helpers/index.ts";
import { parseEnvFile } from "./dotenv.ts";
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
    const cases = await corpus();
    for (const id of [
      "key-name-no-value",
      "json-in-shell-string",
      "zero-width-in-key",
      "zero-width-joiner-in-key",
      "url-password-paren",
      "url-password-quotes-bracket-amp",
      "url-password-second-at",
      "url-password-encoded-at",
    ])
      expect(
        cases.some((c) => c.id === id),
        id,
      ).toBe(true);
    for (const c of cases) {
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

// spec: AC-PERM-30
describe("workspace .env values whatever their names", () => {
  test("a .env value under a name that does not look secret is still redacted", async () => {
    const project = await tempProject({
      ".env": "DB_PASS=hunter22-example-pass\nSTRIPE_SK=sk_live_example_0000fake\nPORT=3000\n",
      "app/.env.production": "DATABASE_URL=postgres-example-host-0001\n",
    });
    try {
      const found = createDotEnvSecrets([project.root]).current();
      expect(found.map((s) => s.name).sort()).toEqual(["DATABASE_URL", "DB_PASS", "STRIPE_SK"]);
      expect(
        redactText(
          "./.env:DB_PASS=hunter22-example-pass\n./.env:STRIPE_SK=sk_live_example_0000fake\nhost postgres-example-host-0001 port 3000",
          found,
        ),
      ).toBe(
        "./.env:DB_PASS=[REDACTED:DB_PASS]\n./.env:STRIPE_SK=[REDACTED:STRIPE_SK]\nhost [REDACTED:DATABASE_URL] port 3000",
      );
    } finally {
      await project.dispose();
    }
  });

  test("an ordinary word or name under a plain name is not redacted; a plain value is redacted inside paths too", async () => {
    const project = await tempProject({
      ".env": [
        "NODE_ENV=production",
        "COMPOSE_PROJECT_NAME=shop-example",
        "AWS_REGION=eu-west-1",
        "SLACK_WEBHOOK=https://hooks.slack.com/services/T0EXAMPLE/B0EXAMPLE/abcdEXAMPLE1234xyz",
        "DB_PASS=hunter22-example-pass",
        "",
      ].join("\n"),
    });
    try {
      const found = createDotEnvSecrets([project.root]).current();
      expect(found.map((s) => s.name).sort()).toEqual(["AWS_REGION", "DB_PASS", "SLACK_WEBHOOK"]);
      expect(
        redactText(
          '/tmp/shop-example/config/production.json infra/eu-west-1/vpc.tf C:\\tf\\eu-west-1.tfvars\nregion = "eu-west-1"',
          found,
        ),
      ).toBe(
        '/tmp/shop-example/config/production.json infra/[REDACTED:AWS_REGION]/vpc.tf C:\\tf\\[REDACTED:AWS_REGION].tfvars\nregion = "[REDACTED:AWS_REGION]"',
      );
      expect(redactText("hook https://hooks.slack.com/services/T0EXAMPLE/B0EXAMPLE/abcdEXAMPLE1234xyz", found)).toBe(
        "hook [REDACTED:SLACK_WEBHOOK]",
      );
    } finally {
      await project.dispose();
    }
  });

  test("a plain value after a slash or backslash the command put there is still redacted", () => {
    const secrets: NamedSecret[] = [
      { name: "DB_PASS", value: "hunter22-example-pass", plain: true },
      { name: "APP_SALT", value: "$ecr3tPass9", plain: true },
    ];
    expect(redactText("DB_PASS=/hunter22-example-pass", secrets)).toBe("DB_PASS=/[REDACTED:DB_PASS]");
    expect(redactText("x\\hunter22-example-pass", secrets)).toBe("x\\[REDACTED:DB_PASS]");
    expect(redactText('declare -x APP_SALT="\\$ecr3tPass9"', secrets)).toBe(
      'declare -x APP_SALT="\\[REDACTED:APP_SALT]"',
    );
  });

  test("a value overlapping the start of a longer secret does not leave the secret's tail visible", () => {
    const secrets: NamedSecret[] = [
      { name: "APP_HOST", value: "db1.example.com" },
      { name: "DB_DSN", value: "example.com/s3cr3t-pass-0001" },
    ];
    expect(redactText("dsn db1.example.com/s3cr3t-pass-0001 end", secrets)).toBe("dsn [REDACTED:APP_HOST] end");
  });

  test("the process environment still joins only by a secret-looking name", () => {
    expect(secretsFromEnv({ DB_PASS: "hunter22-example-pass", HOME: "/home/example-user" })).toEqual([]);
  });
});

// spec: AC-PERM-30
describe("astral character and emoji boundaries", () => {
  test("secrets following emojis or astral characters are cut at exact boundaries without leaking", () => {
    const secrets: NamedSecret[] = [{ name: "STRIPE_SECRET_KEY", value: "rk-live-example-0001-fakevalue" }];
    expect(redactText("prefix 🦊 sk-ant-example-fake-key-000004 tail", [])).toBe(
      "prefix 🦊 [REDACTED:ANTHROPIC_KEY] tail",
    );
    expect(redactText("charge 🚀 rk-live-example-0001-fakevalue now", secrets)).toBe(
      "charge 🚀 [REDACTED:STRIPE_SECRET_KEY] now",
    );
    expect(redactText("token \u{20000}\u{20001} ghp_examplefake0000000000000000000001", [])).toBe(
      "token \u{20000}\u{20001} [REDACTED:GITHUB_TOKEN]",
    );
    expect(redactText("fetch 🦊 https://deploy:s3cr)t@example.com/data", [])).toBe(
      "fetch 🦊 https://deploy:[REDACTED:URL_PASSWORD]@example.com/data",
    );
  });
});

// spec: AC-PERM-30
describe("parseEnvFile", () => {
  test("parses unquoted values with inline comments stripped", () => {
    const parsed = parseEnvFile("DB_PASSWORD=hunter2_longpassword # staging comment\n");
    expect(parsed.DB_PASSWORD).toBe("hunter2_longpassword");
  });

  test("parses multiline quoted values across newlines", () => {
    const raw = `PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIBofakeexample0001
-----END RSA PRIVATE KEY-----"
ANOTHER_VAR=value
`;
    const parsed = parseEnvFile(raw);
    expect(parsed.PRIVATE_KEY).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBofakeexample0001\n-----END RSA PRIVATE KEY-----",
    );
    expect(parsed.ANOTHER_VAR).toBe("value");
  });

  test("preserves hash characters inside quotes and strips trailing comments after quotes", () => {
    const raw = `HASH_IN_VAL="foo # not a comment"
COMMENT_AFTER='bar_val_long' # after quote
`;
    const parsed = parseEnvFile(raw);
    expect(parsed.HASH_IN_VAL).toBe("foo # not a comment");
    expect(parsed.COMMENT_AFTER).toBe("bar_val_long");
  });
});
