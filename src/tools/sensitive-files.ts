import type { Settings } from "../schema/index.ts";

// ASSUMPTION (QUESTIONS Q36): the permissions §4.7 list lives here until the policy module has its data file. `.env.*` is excluded whole, templates included, because a ripgrep glob cannot say "except *.example".
const SENSITIVE_GLOBS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/credentials.json",
  "**/*service-account*.json",
  "**/*.keystore",
  "**/.aws/credentials",
  "**/.docker/config.json",
  "**/secrets.y*ml",
  "**/*.tfvars",
  "**/terraform.tfstate*",
];

export function sensitiveGlobs(settings: Readonly<Settings>): string[] {
  const rule = settings.permissions?.sensitiveFiles;
  const removed = new Set(rule?.remove ?? []);
  return [...SENSITIVE_GLOBS.filter((g) => !removed.has(g)), ...(rule?.add ?? [])];
}
