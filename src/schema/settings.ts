// The complete v0.1 settings key set (interfaces §7). Strict at every level so unknown keys can be reported with a suggestion.
import { z } from "zod";
import { PermissionMode, Protocol, Usd } from "./primitives.ts";

const RULE = /^[A-Za-z0-9_*]+(\(.*\))?$/s;
const API_KEY_REFERENCE = /^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:.+|cmd:.+|none)$/s;

export const PermissionRule = z.string().regex(RULE, {
  error: 'expected a rule like "Tool" or "Tool(specifier)", with nothing after the closing parenthesis',
});

const ApiKeyReference = z.string().regex(API_KEY_REFERENCE, {
  error:
    "a plain-text API key can't be stored in a settings file; run `dovet auth login` to keep it in the keychain, or refer to it as env:NAME, keychain:NAME or cmd:COMMAND",
});

const Strings = z.array(z.string());
const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const Json = z.record(z.string(), z.json());
const DefaultMode = z.union([
  PermissionMode.exclude(["auto"]),
  z.literal("manual").transform(() => "default" as const),
]);

const Provider = z.strictObject({
  protocol: Protocol.optional(),
  baseUrl: z.url().optional(),
  apiKey: ApiKeyReference.optional(),
  models: z.strictObject({ include: Strings.optional(), exclude: Strings.optional() }).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  routing: z.strictObject({ only: Strings.optional() }).optional(),
  quirks: Json.optional(),
  inferenceGeo: z.enum(["global", "us"]).optional(),
});

const Example = z.record(z.string(), z.string()).refine((e) => ["allow", "ask", "deny"].includes(e.expect ?? ""), {
  error: 'needs expect: "allow", "ask" or "deny"',
});

const Permissions = z.strictObject({
  defaultMode: DefaultMode.optional(),
  allow: z.array(PermissionRule).optional(),
  ask: z.array(PermissionRule).optional(),
  deny: z.array(PermissionRule).optional(),
  additionalDirectories: Strings.optional(),
  blockReadsOutsideWorkingDirectories: z.boolean().optional(),
  sensitiveFiles: z.strictObject({ add: Strings.optional(), remove: Strings.optional() }).optional(),
  disableBypassPermissionsMode: z.literal("disable").optional(),
  examples: z.array(Example).optional(),
});

const Sandbox = z.strictObject({
  enabled: z.boolean().optional(),
  autoAllowBashIfSandboxed: z.boolean().optional(),
  allowUnsandboxedCommands: z.boolean().optional(),
  failIfUnavailable: z.boolean().optional(),
  excludedCommands: Strings.optional(),
  enableWeakerNestedSandbox: z.boolean().optional(),
  filesystem: z
    .strictObject({ allowWrite: Strings.optional(), denyWrite: Strings.optional(), denyRead: Strings.optional() })
    .optional(),
  network: z
    .strictObject({
      allowedDomains: Strings.optional(),
      deniedDomains: Strings.optional(),
      strictAllowlist: z.boolean().optional(),
      allowLocalBinding: z.boolean().optional(),
    })
    .optional(),
  credentials: z
    .strictObject({
      files: z.array(z.strictObject({ path: z.string(), mode: z.literal("deny") })).optional(),
      envVars: z.array(z.strictObject({ name: z.string(), mode: z.literal("deny") })).optional(),
    })
    .optional(),
});

const Count = z.number().int().positive();

export const Settings = z.strictObject({
  $schema: z.string().optional(),
  $version: Count.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: Effort.optional(),
  providers: z.record(z.string(), Provider).optional(),
  models: z.record(z.string(), Json).optional(),
  permissions: Permissions.optional(),
  sandbox: Sandbox.optional(),
  shell: z
    .strictObject({
      windows: z.enum(["auto", "git-bash", "powershell"]).optional(),
      gitBashPath: z.string().optional(),
      path: z.string().optional(),
      resetCwd: z.boolean().optional(),
      passEnv: Strings.optional(),
      envFile: z.string().optional(),
      defaultTimeoutMs: Count.optional(),
      maxTimeoutMs: Count.optional(),
      snapshot: z.boolean().optional(),
    })
    .optional(),
  budget: z
    .strictObject({
      session: Usd.nullable().optional(),
      daily: Usd.nullable().optional(),
      turn: Usd.nullable().optional(),
      tokens: Count.nullable().optional(),
      notifyModel: z.boolean().optional(),
    })
    .optional(),
  compaction: z
    .strictObject({ threshold: z.number().gt(0).max(1).optional(), maxTokens: Count.nullable().optional() })
    .optional(),
  checkpoints: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  cache: z.strictObject({ keepAlive: z.boolean().optional(), ttl: z.enum(["auto", "5m", "1h"]).optional() }).optional(),
  instructions: z
    .strictObject({
      files: z.enum(["both", "agents-md-or-claude-md", "claude-md", "agents-md"]).optional(),
      readClaudeUserFiles: z.boolean().optional(),
      exclude: Strings.optional(),
      fromAdditionalDirectories: z.boolean().optional(),
    })
    .optional(),
  read: z.strictObject({ maxTokens: Count.optional() }).optional(),
  glob: z.strictObject({ respectGitignore: z.boolean().optional() }).optional(),
  webfetch: z.strictObject({ deadlineMs: Count.optional(), cacheTtlMs: Count.optional() }).optional(),
  websearch: z
    .strictObject({
      backend: z.enum(["auto", "provider", "exa", "brave", "tavily", "searxng", "off"]).optional(),
      searxngUrl: z.url().optional(),
      perHour: Count.optional(),
      pricePerSearch: Usd.optional(),
    })
    .optional(),
  network: z
    .strictObject({
      streamIdleTimeoutMs: Count.optional(),
      connectTimeoutMs: Count.optional(),
      proxy: z.string().optional(),
      caCertFile: z.string().optional(),
    })
    .optional(),
  refusal: z.strictObject({ fallback: z.enum(["off", "server-default"]).optional() }).optional(),
  failover: z.strictObject({ model: z.string().nullable().optional(), auto: z.boolean().optional() }).optional(),
  plan: z.strictObject({ directory: z.string().optional(), model: z.string().nullable().optional() }).optional(),
  ui: z
    .strictObject({
      renderer: z.enum(["inline", "fullscreen", "plain"]).optional(),
      theme: z.enum(["auto", "dark", "light"]).optional(),
      notifications: z.enum(["auto", "off", "bell"]).optional(),
      reducedMotion: z.boolean().optional(),
      maxProseWidth: Count.optional(),
      terminalTitle: z.boolean().optional(),
      syncOutput: z.enum(["auto", "on", "off"]).optional(),
      keyboardProtocol: z.enum(["auto", "kitty", "legacy"]).optional(),
    })
    .optional(),
  retention: z
    .strictObject({
      days: Count.optional(),
      deleteSessions: z.boolean().optional(),
      outputsDays: Count.optional(),
      warnAtGB: z.number().positive().optional(),
    })
    .optional(),
  titles: z.strictObject({ model: z.string().nullable().optional() }).optional(),
  env: z.record(z.string(), z.union([z.string(), z.number().transform(String)])).optional(),
  updates: z.strictObject({ check: z.boolean().optional() }).optional(),
  compat: z.strictObject({ claudeCodeSettings: z.boolean().optional() }).optional(),
  git: z.strictObject({ attribution: z.enum(["none", "trailer"]).optional() }).optional(),
  memory: z.strictObject({ auto: z.boolean().optional() }).optional(),
  autoMode: z.strictObject({ model: z.string().nullable().optional() }).optional(),
});

export type Settings = z.infer<typeof Settings>;
