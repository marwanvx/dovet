import { Secret } from "../secrets/index.ts";

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH/i;
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

/** Values of env vars whose names say they hold a secret; short values are skipped so common words aren't scrubbed. */
export function secretValuesFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value !== undefined && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name) ? [value] : [],
  );
}

export function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (value instanceof Secret) return REDACTED;
  if (typeof value === "string") return secrets.reduce((s, secret) => s.replaceAll(secret, REDACTED), value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]));
  }
  return value;
}

/** Longest first, so a secret that contains another is replaced whole. */
export function orderSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
}
