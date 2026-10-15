// Dovet's entry point and composition root: the only file that touches `process.*` (architecture "Modules").
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import pkg from "../../package.json";
import { PROVIDER_AUTH } from "../ai/index.ts";
import { type Os, resolveDirs } from "../platform/index.ts";
import { findProjectRoot, loadSettings, openSession, repairEpochEvent, resumeSession } from "../store/index.ts";
import { parseHeadlessArgs } from "./args.ts";
import { authStatus } from "./auth.ts";
import { combineStdinAndPrompt, exitCodeFor, formatJson, formatStreamJson } from "./headless-output.ts";
import { RELEASE_PUBLIC_KEYS } from "./release-signature.ts";
import { ephemeralDataDir, makeUlid, resolveResumeTarget } from "./resume-target.ts";
import { ensureDataDir, filterInheritedEnv, loadTrustedFolders } from "./startup.ts";
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
  if (parsed.noSessionPersistence) dirs.data = await ephemeralDataDir();
  const cleanupEphemeral = async (): Promise<void> => {
    if (parsed.noSessionPersistence) await rm(dirs.data, { recursive: true, force: true });
  };
  const trusted = await loadTrustedFolders(dirs.data, Date.now());
  if (trusted.warning !== undefined) console.error(`dovet: ${trusted.warning}`);
  let projectRoot: string;
  try {
    projectRoot = await findProjectRoot(process.cwd());
  } catch {
    projectRoot = process.cwd();
  }
  let settings: { provider?: string | undefined; model?: string | undefined };
  try {
    const loaded = await loadSettings({ dirs, home: homedir(), projectRoot, env });
    settings = {
      ...(loaded.settings.provider !== undefined ? { provider: loaded.settings.provider } : {}),
      ...(loaded.settings.model !== undefined ? { model: loaded.settings.model } : {}),
    };
  } catch (err) {
    console.error(`dovet: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    await cleanupEphemeral();
    return;
  }
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
  // Resume reopens the log as a stream, applies crash recovery as new events and never rewrites (event-log "Resume").
  let sessionId = `01K7HEADLESS${String(Date.now() % 100000).padStart(5, "0")}STUB0001`;
  if (parsed.resume !== undefined || parsed.continued) {
    const os = hostOs();
    const target = await resolveResumeTarget({ data: dirs.data, projectRoot, os }, parsed.resume, parsed.continued);
    if ("error" in target) {
      console.error(`dovet: ${target.error}`);
      process.exitCode = 2;
      await cleanupEphemeral();
      return;
    }
    const loc = { data: dirs.data, projectRoot, os, session: target.id };
    const resumed = await resumeSession(loc);
    for (const w of resumed.warnings) console.error(`dovet: ${w}`);
    if (resumed.readOnly !== undefined) {
      console.error(
        `dovet: session ${target.id} is read-only (${resumed.readOnly}). Continue from the last valid point with a fork from turn ${resumed.forkTurn ?? "0"}; the original is left untouched.`,
      );
      process.exitCode = 1;
      await cleanupEphemeral();
      return;
    }
    const ulid = (): string => makeUlid(Date.now(), crypto.getRandomValues(new Uint8Array(16)));
    const opened = await openSession({
      ...loc,
      clock: { now: () => Date.now() },
      ids: { ulid },
      pid: process.pid,
      host: hostname(),
      secrets: [],
    });
    if (opened.mode === "read-only") {
      console.error(`dovet: session ${target.id} is read-only (${opened.reason})`);
      process.exitCode = 1;
      await cleanupEphemeral();
      return;
    }
    if (parsed.repair) {
      const ev = repairEpochEvent(resumed.state);
      opened.writer.append({ type: "epoch.start", epoch: ev.epoch, turn: null, data: ev.data });
      console.error(
        `dovet: repair epoch ${ev.epoch} started (reasoning dropped, one cache miss). Nothing in the log was edited.`,
      );
    } else {
      for (const r of resumed.repairs) {
        opened.writer.append({ type: r.type, epoch: r.epoch, turn: r.turn, data: r.data });
      }
      if (resumed.repairs.length > 0) console.error("dovet: crash recovery applied as new events.");
    }
    await opened.writer.close();
    sessionId = target.id;
  }
  // M1-28 runs the startup and output plumbing; the full agent turn arrives with M1-31 (see QUESTIONS Q49).
  // Echoing the prompt exercises stdin, --offline and the output schemas end to end.
  if (parsed.offline) console.error("dovet: offline mode; only model requests leave the machine.");
  const result = combined.prompt;
  if (parsed.output === "json") {
    process.stdout.write(
      formatJson({
        result,
        stopReason: "end_turn",
        incomplete: false,
        sessionId,
        receipt: {},
        usage: {},
        cost: 0,
      }),
    );
  } else if (parsed.output === "stream-json") {
    process.stdout.write(formatStreamJson([{ type: "text", text: result }]));
  } else {
    process.stdout.write(`${result}\n`);
  }
  await cleanupEphemeral();
  process.exitCode = exitCodeFor({ kind: "ok" });
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
} else if (args[0] === "update") {
  console.error("usage: dovet update [--rollback]");
  process.exitCode = 2;
} else {
  process.stdout.write(`dovet ${pkg.version}\n`);
}
