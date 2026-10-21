// Dovet's entry point and composition root: the only file that touches `process.*` (architecture "Modules").
import { realpathSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import pkg from "../../package.json";
import { PROVIDER_AUTH } from "../ai/index.ts";
import { createPlatformCore, type Os, resolveDirs } from "../platform/index.ts";
import type { SandboxState } from "../policy/index.ts";
import type { AbsPath, Settings } from "../schema/index.ts";
import {
  findProjectRoot,
  type LoadedSettings,
  type LoadInput,
  loadSettings,
  type ProjectTrust,
  resolveProjectTrust,
  UNTRUSTED,
} from "../store/index.ts";
import { parseHeadlessArgs } from "./args.ts";
import { authStatus } from "./auth.ts";
import { combineStdinAndPrompt, exitCodeFor, formatJson, formatStreamJson } from "./headless-output.ts";
import { type HeadlessRunOutput, runHeadless as runHeadlessTurn } from "./headless-run.ts";
import { RELEASE_PUBLIC_KEYS } from "./release-signature.ts";
import { ephemeralDataDir, makeUlid } from "./resume-target.ts";
import { installSignalHandlers, stopSignalsFor } from "./signals.ts";
import { ensureDataDir, filterInheritedEnv, loadTrustedFolders, printable } from "./startup.ts";
import { runMaintenance, runStorageCommand, storageSettings } from "./storage-command.ts";
import { detectMusl, hostTargetId, installRootFor, LATEST_RELEASE_URL, rollback, update } from "./update.ts";

// Set by `define` in a pull request's test release only; a normal build has no such identifier (architecture "Distribution").
declare const DOVET_TEST_UPDATE: { publicKey: string; baseUrl: string } | undefined;
const testUpdate = typeof DOVET_TEST_UPDATE === "undefined" ? undefined : DOVET_TEST_UPDATE;

async function runUpdate(rollingBack: boolean): Promise<void> {
  const root = installRootFor(realpathSync(process.execPath));
  const os = process.platform;
  if (rollingBack) {
    const { from, to } = rollback({ root, os });
    console.log(`Rolled back dovet ${from} to ${to}.`);
    return;
  }
  const result = await update({
    root,
    baseUrl: testUpdate?.baseUrl ?? LATEST_RELEASE_URL,
    targetId: hostTargetId(os, process.arch, detectMusl()),
    os,
    publicKeys: testUpdate ? [testUpdate.publicKey] : RELEASE_PUBLIC_KEYS,
  });
  if (result.status === "current") console.log(`dovet ${result.version} is up to date.`);
  else console.log(`Updated dovet ${result.from} to ${result.to}. The next dovet you start is the new one.`);
  if (result.status === "updated")
    for (const e of result.pruneErrors) console.error(`dovet: could not remove an old version: ${e}`);
}

function hostOs(): Os {
  const p = process.platform;
  if (p === "linux" || p === "darwin" || p === "win32") return p;
  throw new Error(`${p} is not a supported platform`);
}

function hasProvider(
  settings: { provider?: string | undefined; model?: string | undefined },
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (settings.provider !== undefined || settings.model !== undefined) return true;
  return Object.values(PROVIDER_AUTH).some((a) => a.envVars.some((v) => env[v] !== undefined && env[v] !== ""));
}

async function readPipedStdin(): Promise<{ text: string; piped: boolean }> {
  if (process.stdin.isTTY === true) return { text: "", piped: false };
  const text = await Bun.stdin.text();
  return { text, piped: true };
}

async function runHeadless(argv: readonly string[]): Promise<void> {
  const parsed = parseHeadlessArgs(argv);
  if ("error" in parsed) {
    console.error(`dovet: ${parsed.error}`);
    process.exitCode = 2;
    return;
  }
  const { clean, ignored } = filterInheritedEnv(process.env);
  if (ignored.length > 0)
    console.error(`dovet: ignoring inherited ${ignored.sort().join(", ")} from a parent Dovet run.`);
  const env = clean as Record<string, string | undefined>;
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
  if (parsed.effort !== undefined && !(EFFORTS as readonly string[]).includes(parsed.effort)) {
    console.error(`dovet: --effort must be one of low, medium, high, xhigh, max (got "${parsed.effort}")`);
    process.exitCode = 2;
    return;
  }
  let dirs: { config: string; data: string; cache: string };
  try {
    dirs = resolveDirs({ os: hostOs(), home: homedir(), env });
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  const dataState = await ensureDataDir(dirs.data);
  if (dataState.notice !== undefined) console.error(`dovet: ${dataState.notice}`);
  // Ephemeral sessions keep no log: a temp data dir removed at exit (event-log "Resume").
  // An unwritable data dir also falls back to a temp dir, so the turn still runs but nothing is saved.
  let ephemeral = parsed.noSessionPersistence;
  if (!dataState.writable && !ephemeral) {
    dirs.data = await ephemeralDataDir();
    ephemeral = true;
  } else if (parsed.noSessionPersistence) {
    dirs.data = await ephemeralDataDir();
  }
  const cleanupEphemeral = async (): Promise<void> => {
    if (ephemeral) await rm(dirs.data, { recursive: true, force: true });
  };
  // AC-LOOP-02/09: SIGINT aborts the turn, a second press within the window flushes and exits 130;
  // SIGTERM/SIGHUP/SIGBREAK flush and release the log, kill the child trees (SIGTERM, then SIGKILL after
  // the grace period), then exit 143/129.
  const os = hostOs();
  const turnController = new AbortController();
  let projectRoot: string;
  try {
    projectRoot = await findProjectRoot(process.cwd());
  } catch {
    projectRoot = process.cwd();
  }
  const core = createPlatformCore({
    os,
    arch: process.arch,
    execPath: realpathSync(process.execPath),
    env,
    projectRoot: projectRoot as AbsPath,
    kill: (pid, signal) => process.kill(pid, signal),
  });
  const signals = installSignalHandlers({
    runtime: {
      onStop: (signal, handler) => {
        process.on(signal, () => handler());
      },
      onCrash: (handler) => {
        process.on("uncaughtException", (err) => handler(err));
        process.on("unhandledRejection", (reason) => handler(reason));
      },
      exit: (code) => process.exit(code),
      now: () => Date.now(),
      writeErr: (text) => {
        process.stderr.write(text);
      },
    },
    signals: stopSignalsFor(os),
    abort: () => turnController.abort(),
    killTrees: () => core.killTrees(),
    crash: { dir: `${dirs.data}/crash`, versions: { dovet: pkg.version, os, arch: process.arch } },
  });
  const trusted = await loadTrustedFolders(dirs.data, Date.now());
  if (trusted.warning !== undefined) console.error(`dovet: ${trusted.warning}`);
  let loaded: LoadedSettings;
  const flags: Settings = {
    ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.effort !== undefined ? { effort: parsed.effort as Settings["effort"] } : {}),
    ...(parsed.budget !== undefined ? { budget: { session: parsed.budget } } : {}),
  };
  const home = homedir();
  // One LoadInput for the startup load and the turn's live reload, so env and flags stay frozen session overrides.
  // projectRoot is a realpath, so the home directory it is compared with must be one too.
  const trustHome = await realpath(home).catch(() => home);
  const trustGit = await core.resolve("git");
  const resolveTrust = (): Promise<ProjectTrust> =>
    resolveProjectTrust({
      projectRoot,
      store: trusted.trusted,
      home: trustHome,
      os,
      dataDir: dirs.data,
      env,
      ...(trustGit === undefined ? {} : { git: trustGit }),
    });
  const loadInput: LoadInput = { dirs, home, projectRoot, env, flags, trust: await resolveTrust(), resolveTrust };
  try {
    loaded = await loadSettings(loadInput);
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    await cleanupEphemeral();
    return;
  }
  const settings = {
    ...(loaded.settings.provider !== undefined ? { provider: loaded.settings.provider } : {}),
    ...(loaded.settings.model !== undefined ? { model: loaded.settings.model } : {}),
  };
  const stdin = await readPipedStdin();
  const combined = combineStdinAndPrompt({ promptArg: parsed.prompt, stdinText: stdin.text, piped: stdin.piped });
  if ("error" in combined) {
    console.error(`dovet: ${combined.error}`);
    process.exitCode = combined.exitCode;
    await cleanupEphemeral();
    return;
  }
  if (!hasProvider(settings, env)) {
    console.error("dovet: no provider connected; run `dovet auth login <provider>` or set e.g. NVIDIA_API_KEY.");
    process.exitCode = 2;
    await cleanupEphemeral();
    return;
  }
  if (parsed.offline) console.error("dovet: offline mode; only model requests leave the machine.");
  const platform = {
    ...core,
    shells: () => ({}),
    clipboard: { readImage: () => Promise.resolve(null), writeText: () => Promise.resolve(undefined) },
  };
  const ulid = (() => {
    let last = "";
    return (): string => {
      // Event ids must sort after the previous one (event-log "Writer rules"); two makeUlid calls in the same
      // millisecond have independent random tails, so without this about half of them would sort backwards.
      let now = Date.now();
      let id = makeUlid(now, crypto.getRandomValues(new Uint8Array(16)));
      while (id <= last) {
        now += 1;
        id = makeUlid(now, crypto.getRandomValues(new Uint8Array(16)));
      }
      last = id;
      return id;
    };
  })();
  const maintenanceStop = new AbortController();
  const maintenance = ephemeral
    ? Promise.resolve([])
    : runMaintenance({
        data: dirs.data,
        now: Date.now(),
        settings: storageSettings(loaded.settings.retention),
        env,
        signal: maintenanceStop.signal,
      });
  const finishMaintenance = async (): Promise<void> => {
    maintenanceStop.abort();
    for (const line of await maintenance) console.error(`dovet: ${printable(line)}`);
  };
  let out: HeadlessRunOutput;
  try {
    out = await runHeadlessTurn({
      dirs,
      projectRoot,
      cwd: process.cwd(),
      os,
      settings: loaded,
      loadInput,
      env,
      args: parsed,
      prompt: combined.prompt,
      clock: { now: () => Date.now() },
      ids: { ulid },
      pid: process.pid,
      host: hostname(),
      platform,
      signal: turnController.signal,
      onSession: (handle) => signals.attach(handle),
    });
  } catch (err) {
    await signals.crash(err);
    await finishMaintenance();
    await cleanupEphemeral();
    process.exitCode = 70;
    return;
  }
  await finishMaintenance();
  for (const w of out.warnings) console.error(`dovet: ${printable(w)}`);
  if (out.exit.kind !== "ok") {
    if (parsed.output === "json") {
      process.stdout.write(
        formatJson({
          result: out.result,
          stopReason: out.stopReason,
          incomplete: out.incomplete,
          sessionId: out.sessionId,
          receipt: out.receipt,
          usage: out.usage,
          cost: out.cost,
        }),
      );
    } else {
      if (out.result !== "") console.error(`dovet: ${out.result}`);
    }
    await cleanupEphemeral();
    process.exitCode = exitCodeFor(out.exit);
    return;
  }
  if (parsed.output === "json") {
    process.stdout.write(
      formatJson({
        result: out.result,
        stopReason: out.stopReason,
        incomplete: out.incomplete,
        sessionId: out.sessionId,
        receipt: out.receipt,
        usage: out.usage,
        cost: out.cost,
      }),
    );
  } else if (parsed.output === "stream-json") {
    const streamEvents =
      out.events !== undefined && out.events.length > 0
        ? out.events.map((e) => ({ type: e.type, ...("data" in e ? { data: e.data } : {}) }))
        : [{ type: "text", text: out.result }];
    process.stdout.write(formatStreamJson(streamEvents));
  } else {
    process.stdout.write(`${out.result}\n`);
  }
  await cleanupEphemeral();
  process.exitCode = exitCodeFor(out.exit);
}

async function runStorage(argv: readonly string[]): Promise<void> {
  const env = filterInheritedEnv(process.env).clean as Record<string, string | undefined>;
  const dirs = resolveDirs({ os: hostOs(), home: homedir(), env });
  const home = homedir();
  const projectRoot = await findProjectRoot(process.cwd()).catch(() => process.cwd());
  const loaded = await loadSettings({ dirs, home, projectRoot, env, trust: UNTRUSTED });
  const out = await runStorageCommand(argv, {
    data: dirs.data,
    now: Date.now(),
    settings: storageSettings(loaded.settings.retention),
    env,
  });
  if (out.exitCode === 0) process.stdout.write(out.output);
  else process.stderr.write(out.output);
  process.exitCode = out.exitCode;
}

async function runSandbox(argv: readonly string[]): Promise<void> {
  const os = hostOs();
  const { runSandboxCommand } = await import("./sandbox.ts");
  const { backendFor, checkMxcSupport, selectWindowsBackend, windowsStateFor } = await import("../policy/index.ts");
  const { libexecPath } = await import("../platform/index.ts");
  let backend = backendFor(os);
  let detail = "n/a";
  let provisioned = false;
  let state: SandboxState = "off";
  if (os === "win32") {
    const mxc = await checkMxcSupport();
    detail = mxc.detail;
    try {
      const { checkWindowsSandboxStatusAsync, resolveSrtWin } = await import("@anthropic-ai/sandbox-runtime");
      const exe = realpathSync(process.execPath);
      const srtDir = libexecPath(exe, os, "srt");
      const { join } = await import("node:path");
      const status = await checkWindowsSandboxStatusAsync({
        srtWin: resolveSrtWin({ path: join(srtDir, "srt-win.exe") }),
      });
      provisioned = status.user.provisioned;
    } catch {
      provisioned = false;
    }
    const mxcSupported = mxc.supported;
    backend = selectWindowsBackend({ mxcSupported, srtInstalled: provisioned }).backend;
    state = windowsStateFor(backend);
  } else {
    try {
      const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
      const exe = realpathSync(process.execPath);
      let rgCmd: string | undefined;
      try {
        const { existsSync } = await import("node:fs");
        const p = libexecPath(exe, os, "rg");
        if (existsSync(p)) rgCmd = p;
      } catch {}
      const deps = SandboxManager.checkDependencies(rgCmd ? { command: rgCmd } : undefined);
      state = deps.errors.length > 0 ? "off" : "on";
    } catch {
      state = "off";
    }
  }
  const { installWindowsSandboxAsync, resolveSrtWin, uninstallWindowsSandbox } = await import(
    "@anthropic-ai/sandbox-runtime"
  );
  const { join } = await import("node:path");
  const srtWin = (): { exe: string; prependArgs: readonly string[] } => {
    const exe = realpathSync(process.execPath);
    return resolveSrtWin({ path: join(libexecPath(exe, os, "srt"), "srt-win.exe") });
  };
  const out = await runSandboxCommand(argv.slice(1), {
    os,
    backend,
    state,
    check: async () => ({ provisioned, detail }),
    install: async () => {
      const r = await installWindowsSandboxAsync({ srtWin: srtWin() });
      return r.cancelled === true ? { cancelled: true as const } : {};
    },
    uninstall: async () => {
      const r = uninstallWindowsSandbox({ srtWin: srtWin() });
      return r.cancelled === true ? { cancelled: true as const } : {};
    },
  });
  if (out.exitCode === 0) process.stdout.write(out.output);
  else process.stderr.write(out.output);
  process.exitCode = out.exitCode;
}

const args = process.argv.slice(2);
if (args.includes("-p") || args.includes("--print")) {
  try {
    await runHeadless(args);
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else if (args[0] === "update" && (args.length === 1 || (args.length === 2 && args[1] === "--rollback"))) {
  try {
    await runUpdate(args.length === 2);
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else if (args[0] === "auth" && args[1] === "status" && args.length === 2) {
  try {
    process.stdout.write(await authStatus({ os: hostOs(), home: homedir(), cwd: process.cwd(), env: process.env }));
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else if (args[0] === "gc" || args[0] === "sessions") {
  try {
    await runStorage(args);
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else if (args[0] === "sandbox" && args.length === 2) {
  try {
    await runSandbox(args);
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else if (args[0] === "sandbox") {
  console.error("usage: dovet sandbox <install|uninstall|status>");
  process.exitCode = 2;
} else if (args[0] === "update") {
  console.error("usage: dovet update [--rollback]");
  process.exitCode = 2;
} else {
  process.stdout.write(`dovet ${pkg.version}\n`);
}
