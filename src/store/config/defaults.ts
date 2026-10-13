import type { Settings } from "../../schema/index.ts";

/** Level 6 of the precedence chain: only keys whose default the specs state as a value (interfaces §7, cli-config). */
export const DEFAULTS: Settings = {
  permissions: { defaultMode: "default", allow: [], ask: [], deny: [], blockReadsOutsideWorkingDirectories: false },
  budget: { session: null, daily: null, turn: null, notifyModel: false },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    failIfUnavailable: false,
    enableWeakerNestedSandbox: false,
  },
  shell: { windows: "auto", passEnv: [] },
  instructions: { files: "both", readClaudeUserFiles: true },
  compaction: { threshold: 0.9, maxTokens: null },
  checkpoints: { enabled: true },
  cache: { keepAlive: false, ttl: "auto" },
  glob: { respectGitignore: true },
  refusal: { fallback: "off" },
  failover: { model: null, auto: false },
  ui: { renderer: "inline", theme: "auto", notifications: "auto", reducedMotion: false },
  retention: { days: 30, deleteSessions: false, outputsDays: 7, warnAtGB: 10 },
  updates: { check: true },
  compat: { claudeCodeSettings: true },
  git: { attribution: "none" },
};
