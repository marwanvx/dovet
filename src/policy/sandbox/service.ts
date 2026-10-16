// SandboxService (permissions §7, interfaces §2b).
import { lstat, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxManager as ManagerType } from "@anthropic-ai/sandbox-runtime";
import type { Settings } from "../../schema/index.ts";
import {
  expandProtectedSymlinks,
  normalizeHost,
  normalizeSandboxPath,
  sandboxProtectedDenyWrite,
  worktreeCommonDenies,
} from "./hygiene.ts";
import { type SandboxOs, startSandbox } from "./init.ts";

export type SandboxState = "on" | "weak" | "experimental" | "off";
export type SandboxBackend = "bubblewrap" | "seatbelt" | "mxc" | "srt-windows" | "none";

export interface SandboxWrapRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface SandboxWrapped {
  argv: string[];
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface SandboxService {
  readonly state: SandboxState;
  readonly backend: SandboxBackend;
  readonly ready: Promise<void>;
  sessionTmp(): string;
  /** ASSUMPTION (QUESTIONS Q54): async because sandbox-runtime wrap, tmp creation and symlink re-checks are async. */
  wrap(cmd: SandboxWrapRequest, opts: { unsandboxed: boolean }): Promise<SandboxWrapped>;
  violations(since: number): string[];
  globWarnings(): string[];
}

export const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "repo.maven.apache.org",
  "api.nuget.org",
];

export const DEFAULT_CREDENTIAL_DENY_FILES = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
];

/** Status-bar text: healthy names the backend; off says commands are judged by text (permissions §0b, §7.6). */
export function sandboxStatus(state: SandboxState, backend: SandboxBackend): string {
  if (state === "off") return "sandbox: off (commands judged by text)";
  if (state === "weak") return "sandbox: weak";
  if (state === "experimental") return `sandbox: experimental (${backend})`;
  return `sandbox: on (${backend})`;
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export function backendFor(os: SandboxOs): SandboxBackend {
  if (os === "linux") return "bubblewrap";
  if (os === "darwin") return "seatbelt";
  return "none";
}

export type SandboxServiceOptions = {
  os: SandboxOs;
  srtDir: string;
  rgPath?: string | undefined;
  settings: Settings;
  workingDirs: readonly string[];
  sessionId: string;
  configDir: string;
  dataDir: string;
  home: string;
  tmpBase?: string;
  starter?: (opts: Parameters<typeof startSandbox>[0]) => Promise<typeof ManagerType>;
};

export function sandboxConfigFor(opts: SandboxServiceOptions, sessionTmp: string): Parameters<typeof startSandbox>[0] {
  const home = opts.home;
  const norm = (p: string): string => normalizeSandboxPath(p, home);
  const allowWrite = [...opts.workingDirs, sessionTmp];
  const extraWrite = opts.settings.sandbox?.filesystem?.allowWrite ?? [];
  for (const p of extraWrite) allowWrite.push(norm(p));
  const denyRead = DEFAULT_CREDENTIAL_DENY_FILES.map(norm);
  for (const p of opts.settings.sandbox?.filesystem?.denyRead ?? []) denyRead.push(norm(p));
  const credFiles = opts.settings.sandbox?.credentials?.files ?? [];
  for (const f of credFiles) denyRead.push(norm(f.path));
  const denyWrite = sandboxProtectedDenyWrite([...opts.workingDirs], opts.configDir, opts.dataDir);
  for (const p of opts.settings.sandbox?.filesystem?.denyWrite ?? []) denyWrite.push(norm(p));
  const hostOk = (h: string): string | undefined => {
    const r = normalizeHost(h);
    return r.ok ? r.host : undefined;
  };
  const allowed = new Set<string>(DEFAULT_ALLOWED_DOMAINS);
  for (const h of opts.settings.sandbox?.network?.allowedDomains ?? []) {
    const v = hostOk(h);
    if (v !== undefined) allowed.add(v);
  }
  for (const rule of opts.settings.permissions?.allow ?? []) {
    const m = /^WebFetch\(domain:(.*)\)$/i.exec(rule.trim());
    if (m?.[1] !== undefined) {
      const v = hostOk(m[1]);
      if (v !== undefined) allowed.add(v);
    }
  }
  const denied: string[] = [];
  for (const h of opts.settings.sandbox?.network?.deniedDomains ?? []) {
    const v = hostOk(h);
    if (v !== undefined) denied.push(v);
  }
  const envVars = (opts.settings.sandbox?.credentials?.envVars ?? []).map((e) => ({
    name: e.name,
    mode: "deny" as const,
  }));
  return {
    os: opts.os,
    srtDir: opts.srtDir,
    ...(opts.rgPath === undefined ? {} : { rgPath: opts.rgPath }),
    allowWrite,
    denyRead,
    denyWrite,
    allowedDomains: [...allowed],
    deniedDomains: denied,
    ...(envVars.length === 0 && credFiles.length === 0
      ? {}
      : {
          credentials: {
            files: [
              ...DEFAULT_CREDENTIAL_DENY_FILES.map((p) => ({ path: norm(p), mode: "deny" as const })),
              ...credFiles.map((f) => ({ path: norm(f.path), mode: "deny" as const })),
            ],
            ...(envVars.length === 0 ? {} : { envVars }),
          },
        }),
    ...(opts.settings.sandbox?.network?.allowLocalBinding === undefined
      ? {}
      : { allowLocalBinding: opts.settings.sandbox.network.allowLocalBinding }),
    ...(opts.settings.sandbox?.enableWeakerNestedSandbox === undefined
      ? {}
      : { enableWeakerNestedSandbox: opts.settings.sandbox.enableWeakerNestedSandbox }),
    ...(opts.settings.sandbox?.network?.strictAllowlist === undefined
      ? {}
      : { strictAllowlist: opts.settings.sandbox.network.strictAllowlist }),
  };
}

async function worktreeDenies(workingDirs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const wd of workingDirs) {
    try {
      const dotGit = join(wd, ".git");
      const st = await lstat(dotGit);
      if (!st.isFile()) continue;
      const text = await readFile(dotGit, "utf8");
      const m = /^gitdir:\s*(.+)\s*$/.exec(text.trim());
      if (m?.[1] === undefined) continue;
      const gitdir = resolve(wd, m[1]);
      try {
        const commonText = await readFile(join(gitdir, "commondir"), "utf8");
        const common = resolve(gitdir, commonText.trim());
        out.push(...worktreeCommonDenies(common));
        continue;
      } catch {}
      const common = gitdir.includes("/worktrees/") ? resolve(gitdir, "../..") : gitdir;
      out.push(...worktreeCommonDenies(common));
    } catch {}
  }
  return out;
}

export function createSandboxService(opts: SandboxServiceOptions): SandboxService {
  const backend = backendFor(opts.os);
  const weak = opts.settings.sandbox?.enableWeakerNestedSandbox === true;
  let state: SandboxState = "off";
  const tmp = join(opts.tmpBase ?? tmpdir(), `dovet-${opts.sessionId}`);
  let manager: typeof ManagerType | undefined;
  let warnings: string[] = [];
  const rejectedHosts: string[] = [];
  let sessionAllowWrite: string[] = [...opts.workingDirs, tmp];
  let sessionDenyRead: string[] = [];
  let sessionDenyWrite: string[] = [];
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  if (opts.os === "win32" || opts.settings.sandbox?.enabled === false) {
    readyResolve();
  } else {
    void (async () => {
      try {
        const starter = opts.starter ?? startSandbox;
        const base = sandboxConfigFor(opts, tmp);
        const extra = await worktreeDenies(opts.workingDirs);
        const denyWrite = [...(base.denyWrite ?? []), ...extra];
        const denyRead = [...(base.denyRead ?? [])];
        const expandedWrite = await expandProtectedSymlinks(denyWrite);
        const expandedRead = await expandProtectedSymlinks(denyRead);
        sessionAllowWrite = [...(base.allowWrite ?? [])];
        sessionDenyRead = [...expandedRead];
        sessionDenyWrite = [...expandedWrite];
        for (const h of [
          ...(opts.settings.sandbox?.network?.allowedDomains ?? []),
          ...(opts.settings.sandbox?.network?.deniedDomains ?? []),
        ]) {
          const r = normalizeHost(h);
          if (!r.ok) rejectedHosts.push(h);
        }
        manager = await starter({ ...base, denyWrite: expandedWrite, denyRead: expandedRead });
        const deps = manager.checkDependencies();
        try {
          warnings = manager.getLinuxGlobPatternWarnings() ?? [];
        } catch {
          warnings = [];
        }
        if (deps.errors.length > 0) {
          state = "off";
        } else {
          state = weak ? "weak" : "on";
        }
      } catch {
        state = "off";
      } finally {
        readyResolve();
      }
    })();
  }
  return {
    get state(): SandboxState {
      return state;
    },
    backend,
    ready,
    sessionTmp: (): string => tmp,
    wrap: async (cmd, o): Promise<SandboxWrapped> => {
      await ready;
      if (o.unsandboxed || state === "off" || manager === undefined) {
        return { argv: cmd.argv, env: cmd.env, cleanup: async () => {} };
      }
      await mkdir(tmp, { recursive: true });
      const denyWrite = sandboxProtectedDenyWrite([cmd.cwd], opts.configDir, opts.dataDir);
      const expanded = await expandProtectedSymlinks(denyWrite);
      const union = [...new Set([...sessionDenyWrite, ...expanded])];
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const commandText = cmd.argv.map(quote).join(" ");
      const wrapped = await manager.wrapWithSandbox(
        commandText,
        undefined,
        { filesystem: { allowWrite: sessionAllowWrite, denyRead: sessionDenyRead, denyWrite: union } },
        undefined,
        {
          commandId: id,
        },
      );
      return {
        argv: ["/bin/sh", "-c", wrapped],
        env: cmd.env,
        cleanup: async (): Promise<void> => {
          manager?.cleanupAfterCommand();
        },
      };
    },
    violations: (since: number): string[] => {
      if (manager === undefined) return [];
      try {
        return manager
          .getSandboxViolationStore()
          .getViolations()
          .filter((v) => v.timestamp.getTime() >= since)
          .map((v) => v.line);
      } catch {
        return [];
      }
    },
    globWarnings: (): string[] => [...warnings, ...rejectedHosts.map((h) => `ambiguous host ${h} (see /doctor)`)],
  };
}

/** A passthrough service for tests: real spawn, scripted health and violations. */
export function fakeSandboxService(
  state: SandboxState = "on",
  backend: SandboxBackend = "bubblewrap",
  violate: string[] = [],
  tmp = "/tmp/dovet-fake-session",
): SandboxService {
  return {
    state,
    backend,
    ready: Promise.resolve(),
    sessionTmp: (): string => tmp,
    wrap: async (cmd, o): Promise<SandboxWrapped> => {
      if (o.unsandboxed || state === "off") return { argv: cmd.argv, env: cmd.env, cleanup: async () => {} };
      return { argv: cmd.argv, env: { ...cmd.env, TMPDIR: tmp }, cleanup: async () => {} };
    },
    violations: (_since: number): string[] => [...violate],
    globWarnings: (): string[] => [],
  };
}
