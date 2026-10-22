// Headless agent turn (tui "Headless mode", agent-loop "Turn state machine", event-log "Resume", providers §1).
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json";
import {
  BudgetMeter,
  buildRequest,
  type ContextMark,
  cacheReadOf,
  cacheWarning,
  checkTranscriptPairing,
  compact,
  countImages,
  DailyLedger,
  DEFAULT_IMAGE_TOKENS,
  decideStopAction,
  discoverInstructions,
  ENDED_NOT_RUN,
  type ExecutedResult,
  estimateContext,
  estimateRequest,
  executeTools,
  forkedPlanUnannounced,
  GuardTracker,
  hasOpenRound,
  headerOf,
  historyRepairOffer,
  INTERRUPT_INSTRUCTION,
  INTERRUPTED_NOT_RUN,
  type InstructionContext,
  instructionsUpdated,
  isEarlyEligible,
  type Limits,
  type LoadedInstruction,
  MAX_REQUESTS_PER_TURN,
  modeChangeInstructions,
  modelRequestBody,
  modelRequestData,
  newPlanFile,
  type ParsedCall,
  PLACEHOLDER_RATES,
  parseToolCalls,
  planReattach,
  prefixFingerprint,
  prompt,
  REFUSAL_NOT_RUN,
  renderSystemPrompt,
  requestCapFor,
  responseSpend,
  type SendSummary,
  serializeTools,
  sessionDate,
  shellToolFor,
  shellToolName,
  shouldAppendInterrupted,
  shouldCompact,
  shouldContinueForOpenTasks,
  shouldDiscardEarly,
  startEpoch,
  streamInterruptResults,
  TRUNCATED_NOT_RUN,
  transcriptChars,
} from "../agent/index.ts";
import {
  callModel,
  createSdkAdapter,
  endpointOf,
  imageSupport,
  type ProviderRequest,
  pdfSupport,
  providerRecord,
  type RenderInput,
  type SdkCall,
  type StreamEvent,
  type TokenTotals,
} from "../ai/index.ts";
import {
  canonicalizePath,
  isErrno,
  type Os,
  type Platform,
  pathKey,
  readGitHead,
  type ShellChoice,
} from "../platform/index.ts";
import {
  analyzeShell,
  createDotEnvSecrets,
  createSandboxService,
  decide,
  expandGlob,
  isDirectory,
  loadShellParsers,
  type NamedSecret,
  type RuleSet,
  ruleSetFromSettings,
  type SandboxService,
  type SandboxServiceOptions,
  type State,
  sandboxStatus,
  secretsFromEnv,
} from "../policy/index.ts";
import type { AbsPath, EventEnvelope, Settings, StoredResponse } from "../schema/index.ts";
import { BudgetEventData, InstructionsLoadedData, PermissionMode } from "../schema/index.ts";
import {
  createBlobStore,
  createCredentials,
  createSecretStore,
  describeProblem,
  type ExternalImportApprovals,
  externalImportApprovals,
  forkSession,
  isHistoryRelated,
  type LoadedSettings,
  type LoadInput,
  openCheckpoints,
  openSession,
  PLAN_FILE_KEY,
  planFileAllowed,
  pollSettings,
  projectId,
  projectPlanDir,
  REPAIR_HINT,
  readSession,
  repairEpochEvent,
  resumeSession,
  Secret,
  SettingsError,
  type SettingsSnapshot,
  sessionPaths,
  snapshotSettings,
  validateTranscriptItems,
} from "../store/index.ts";
import {
  buildReadResultsIndex,
  builtinTools,
  createMediaBudget,
  createReadState,
  createToolRegistry,
  createWebFetchTool,
  type MediaContext,
  type ShellSnapshot,
  startShellSnapshot,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
  toolInputSchema,
  type WebSearchTool,
} from "../tools/index.ts";
import type { HeadlessArgs } from "./args.ts";
import type { HeadlessOutcome } from "./headless-output.ts";
import { resolveResumeTarget } from "./resume-target.ts";
import { offlineRefusal } from "./startup.ts";
import { SEARCH_SERVICE_AUTH, setupWebSearch } from "./web-search-setup.ts";

export type HeadlessAdapter = {
  render(input: RenderInput): SdkCall;
  stream(
    call: SdkCall,
    opts: { signal: AbortSignal; onRequest: (r: ProviderRequest) => void },
  ): AsyncIterable<StreamEvent>;
};

const PLACEHOLDER_CONTEXT_WINDOW = 200_000;

export type HeadlessRunInput = {
  dirs: { config: string; data: string; cache: string };
  projectRoot: string;
  cwd: string;
  os: Os;
  settings: LoadedSettings;
  /** The exact startup LoadInput (frozen env and flags); live reload re-passes it on every poll. */
  loadInput: LoadInput;
  env: Record<string, string | undefined>;
  args: HeadlessArgs;
  prompt: string;
  clock: { now(): number };
  ids: { ulid(): string };
  pid: number;
  host: string;
  platform: Platform;
  adapter?: HeadlessAdapter;
  toolDefs?: readonly ToolDefinition<unknown>[];
  /** The model's context window in tokens; until the catalog (M4-02) knows it, the placeholder is used. */
  contextWindow?: number;
  /** The turn's abort signal (SIGINT); an abort ends the turn interrupted with exit 130, never as an error. */
  signal?: AbortSignal;
  /** The open writer, so the CLI's signal handling can flush it before the process exits. */
  onSession?(handle: { shutdown(): Promise<void>; eventTypes(): readonly string[] }): void;
  /** WebSearch's provider backend: the secondary request to the session's model. Absent when the endpoint has no search mechanism. */
  searchComplete?: NonNullable<ToolContext["model"]>["complete"];
  /** Replaces the network the search services are called through; tests only. */
  searchFetch?: typeof fetch;
  /** Starts sandbox-runtime; tests pass a fake manager, the product leaves it unset. */
  sandboxStarter?: SandboxServiceOptions["starter"];
};

export type HeadlessRunOutput = {
  sessionId: string;
  result: string;
  stopReason: string;
  incomplete: boolean;
  usage: Record<string, unknown>;
  cost: number | null;
  receipt: Record<string, unknown>;
  exit: HeadlessOutcome;
  warnings: string[];
  events?: readonly EventEnvelope[];
};

export function resolveHeadlessModel(
  settings: LoadedSettings["settings"],
  args: Pick<HeadlessArgs, "provider" | "model" | "effort">,
): { provider: string; model: string; effort?: string } | { error: string } {
  const provider = args.provider ?? settings.provider ?? "nvidia";
  const model = args.model ?? settings.model;
  if (model === undefined || model === "") return { error: "no model configured; set model in settings or --model" };
  const effort = args.effort ?? settings.effort;
  if (effort === undefined) return { provider, model };
  return { provider, model, effort };
}

export function headlessToolDefs(input: {
  shell?: ShellChoice | undefined;
  tmpDir: string;
  snapshot?: ShellSnapshot | undefined;
  offline?: boolean;
  search?: WebSearchTool | undefined;
  baseTools?: readonly ToolDefinition<unknown>[];
}): ToolDefinition<unknown>[] {
  const base = [...(input.baseTools ?? builtinTools)];
  return [
    ...base.filter((t) => {
      if (t.name === "Bash" || t.name === "PowerShell" || t.name === "AskUserQuestion" || t.name === "WebFetch")
        return false;
      if (input.offline && t.name === "WebSearch") return false;
      return true;
    }),
    shellToolFor(input.shell, input.tmpDir, input.snapshot),
    ...(input.search === undefined || input.offline ? [] : [input.search as ToolDefinition<unknown>]),
    ...(input.offline
      ? []
      : [createWebFetchTool({ outputDir: `${input.tmpDir}/out`, version: pkg.version }) as ToolDefinition<unknown>]),
  ] as ToolDefinition<unknown>[];
}

function toToolDef(def: ToolDefinition<unknown>): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  let description: string;
  try {
    description = prompt(def.descriptionFile);
  } catch {
    description = def.name;
  }
  return { name: def.name, description, inputSchema: toolInputSchema(def) };
}

function errOut(sessionId: string, result: string, exit: HeadlessOutcome, warnings: string[]): HeadlessRunOutput {
  return {
    sessionId,
    result,
    stopReason: "error",
    incomplete: false,
    usage: {},
    cost: null,
    receipt: {},
    exit,
    warnings,
  };
}

/** Provider usage objects can hold undefined (AI SDK token details); the log and `--output json` need plain JSON. */
function jsonSafeUsage(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value) ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Adds provider usage objects field by field (nested objects too); a non-numeric field takes the newer value. */
function addUsage(total: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...total };
  for (const [key, value] of Object.entries(next)) {
    const before = out[key];
    if (typeof before === "number" && typeof value === "number") out[key] = before + value;
    else if (isPlainRecord(before) && isPlainRecord(value)) out[key] = addUsage(before, value);
    else out[key] = value;
  }
  return out;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function budgetLimits(cli: number | undefined, b: Settings["budget"]): Limits {
  return {
    turn: b?.turn ?? null,
    session: cli ?? b?.session ?? null,
    day: b?.daily ?? null,
    tokens: b?.tokens ?? null,
  };
}

export function openTasksFromEvents(events: readonly EventEnvelope[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "tool.call" && (e.data as { name?: string })?.name === "TodoWrite") {
      const data = e.data as { raw?: unknown; input?: unknown };
      const raw = (data.input ?? data.raw) as { todos?: readonly { status?: string }[] } | undefined;
      const todos = Array.isArray(raw?.todos) ? raw.todos : [];
      return todos.filter((t) => t.status === "pending" || t.status === "in_progress").length;
    }
  }
  return 0;
}

const SHELL_TOOLS: readonly string[] = ["Bash", "PowerShell"];

/** Headless asks no one: an external import is skipped for this run and the skip is not stored, so the dialog can still ask later. */
function skipUnapproved(stored: ExternalImportApprovals): ExternalImportApprovals {
  const thisRun = new Map<string, boolean>();
  return {
    decision: async (path) => thisRun.get(path) ?? (await stored.decision(path)),
    record: (paths, approved) => {
      for (const p of paths) thisRun.set(p, approved);
      return Promise.resolve();
    },
  };
}

/** `null` for any path that can't be stat'ed (gone, a symlink loop, no access): discovery decides whether it still loads. */
const mtimeOf = (path: string): Promise<number | null> =>
  stat(path, { bigint: true }).then(
    // The same arithmetic discovery used to record it: the double `mtimeMs` of a plain stat differs in its last bits.
    (info) => Number(info.mtimeNs) / 1e6,
    () => null,
  );

type DroppedFile = { path: string; mtimeMs: number | null };

/** A cheap check before the full reload: a launch file whose modification time changed or that is gone, or a dropped one that changed. */
async function instructionFilesMoved(
  files: readonly LoadedInstruction[],
  dropped: ReadonlyMap<string, DroppedFile>,
): Promise<boolean> {
  for (const f of files) if ((await mtimeOf(f.path)) !== f.mtimeMs) return true;
  for (const d of dropped.values()) if ((await mtimeOf(d.path)) !== d.mtimeMs) return true;
  return false;
}

export async function runHeadless(input: HeadlessRunInput): Promise<HeadlessRunOutput> {
  const warnings: string[] = [];
  if (input.args.repair && input.args.resume === undefined && !input.args.continued)
    return errOut("", "--repair needs --resume or --continue", { kind: "usage" }, warnings);
  if (input.args.fork && input.args.resume === undefined && !input.args.continued)
    return errOut("", "--fork needs --resume or --continue", { kind: "usage" }, warnings);
  const resolved = resolveHeadlessModel(input.settings.settings, input.args);
  if ("error" in resolved) return errOut("", resolved.error, { kind: "usage" }, warnings);
  const { provider, model } = resolved;
  const effort = "effort" in resolved ? resolved.effort : undefined;
  const flagMode = input.args.permissionMode;
  let mode = input.settings.settings.permissions?.defaultMode ?? "default";
  if (flagMode !== undefined) {
    const parsedMode = PermissionMode.safeParse(flagMode);
    if (parsedMode.success !== true)
      return errOut(
        "",
        `--permission-mode must be one of default, acceptEdits, plan, dontAsk, bypassPermissions (got "${flagMode}")`,
        { kind: "usage" },
        warnings,
      );
    mode = parsedMode.data === "auto" ? "default" : parsedMode.data;
  }
  // Live settings reload (cli-config): snapshot the watched files once; the turn polls before each batch.
  // A malformed settings file fails the run closed (permissions §3.1), before any session event is written.
  let snapshot: SettingsSnapshot;
  try {
    snapshot = await snapshotSettings(input.loadInput);
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    return errOut("", `invalid settings: ${err.problems.map(describeProblem).join("; ")}`, { kind: "usage" }, warnings);
  }
  warnings.push(...input.settings.warnings.map(describeProblem));

  const configured = input.settings.settings.providers?.[provider];
  const record = (() => {
    try {
      return providerRecord(provider);
    } catch {
      return undefined;
    }
  })();
  const baseURL = configured?.baseUrl ?? (record !== undefined ? endpointOf(record).baseURL : undefined);
  if (baseURL === undefined) return errOut("", `no provider record "${provider}"`, { kind: "usage" }, warnings);

  const store = createSecretStore({ os: input.os, file: `${input.dirs.data}/credentials.json` });
  const credentials = createCredentials({
    store,
    env: input.env,
    runCommand: () => Promise.reject(new Error("cmd: keys are not resolved in headless mode")),
    providers: {
      ...Object.fromEntries(Object.entries(SEARCH_SERVICE_AUTH).map(([id, auth]) => [id, { auth }])),
      [provider]: {
        auth:
          record !== undefined
            ? { id: provider, envVars: record.auth.flatMap((a) => a.envVars) }
            : { id: provider, envVars: [] },
        ...(configured?.apiKey === undefined ? {} : { reference: configured.apiKey }),
      },
    },
  });
  let secretValue: string;
  try {
    const found = await credentials.resolve(provider);
    if (found?.secret === undefined)
      return errOut(
        "",
        `no provider connected; run \`dovet auth login ${provider}\` or set e.g. NVIDIA_API_KEY.`,
        { kind: "usage" },
        warnings,
      );
    secretValue = found.secret.reveal();
  } catch (err) {
    return errOut("", err instanceof Error ? err.message : String(err), { kind: "usage" }, warnings);
  }

  const search =
    input.toolDefs === undefined && !input.args.offline
      ? await setupWebSearch({
          settings: input.settings.settings,
          credentials,
          providerSearch: input.searchComplete !== undefined,
          ...(input.searchFetch === undefined ? {} : { fetch: input.searchFetch }),
        })
      : undefined;
  warnings.push(...(search?.warnings ?? []));

  // The output-redaction set (permissions §8, §4.7): the provider credential, secret-named env vars
  // and workspace `.env*` values, re-read regularly so edited files are picked up.
  const dotEnvSecrets = createDotEnvSecrets([input.projectRoot]);
  const outputSecrets = (): NamedSecret[] => [
    { name: "CREDENTIAL", value: secretValue },
    ...(search?.keys ?? []).map((k, i) => ({ name: `SEARCH_KEY_${i + 1}`, value: k.reveal() })),
    ...secretsFromEnv(input.env),
    ...dotEnvSecrets.current(),
  ];

  const ep = record !== undefined ? endpointOf(record) : undefined;
  const endpointBase = {
    package: ep?.package ?? record?.endpoints[0]?.package ?? "@ai-sdk/openai-compatible",
    baseURL,
    quirks: ep?.quirks ?? {},
  };
  const blobs = createBlobStore(input.dirs.data);
  const adapter: HeadlessAdapter =
    input.adapter ??
    createSdkAdapter({
      blobBytes: (sha) => blobs.getSync(sha),
      endpoint: () => ({ ...endpointBase, baseURL, apiKey: new Secret(secretValue) }),
      modelInfo: () => ({
        effortLevels:
          ep?.effortLevels !== undefined && ep.effortLevels.length > 0
            ? ep.effortLevels
            : ["minimal", "low", "medium", "high", "xhigh", "max"],
      }),
    });

  let sessionId: string;
  if (input.args.resume !== undefined || input.args.continued) {
    const target = await resolveResumeTarget(
      { data: input.dirs.data, projectRoot: input.projectRoot, os: input.os },
      input.args.resume,
      input.args.continued,
    );
    if ("error" in target) return errOut("", target.error, { kind: "usage" }, warnings);
    sessionId = target.id;
  } else {
    sessionId = input.ids.ulid();
  }

  let loc = { data: input.dirs.data, projectRoot: input.projectRoot, os: input.os, session: sessionId };
  let resumed = await resumeSession(loc);
  warnings.push(...resumed.warnings);
  if (resumed.readOnly !== undefined) {
    if (input.args.fork && resumed.forkTurn !== undefined && resumed.forkTurn !== null) {
      const newSessionId = input.ids.ulid();
      await forkSession(loc, newSessionId, resumed.forkTurn, { ids: input.ids, clock: input.clock });
      warnings.push(
        `forked session ${newSessionId} from turn ${resumed.forkTurn}; original session ${sessionId} left untouched.`,
      );
      sessionId = newSessionId;
      loc = { ...loc, session: sessionId };
      resumed = await resumeSession(loc);
      warnings.push(...resumed.warnings);
    } else {
      const forkOffer =
        resumed.forkTurn !== undefined && resumed.forkTurn !== null
          ? `. Continue from the last valid point with --fork (from turn ${resumed.forkTurn}); the original is left untouched.`
          : "";
      return errOut(
        sessionId,
        `session ${sessionId} is read-only (${resumed.readOnly})${forkOffer}`,
        { kind: "error" },
        warnings,
      );
    }
  }

  let effectiveModel = model;
  if (resumed.lines > 0) {
    if (flagMode === undefined && resumed.state.mode !== "") {
      const parsed = PermissionMode.safeParse(resumed.state.mode);
      if (parsed.success) mode = parsed.data === "auto" ? "default" : parsed.data;
    }
    if (resumed.state.provider !== "" && provider !== resumed.state.provider) {
      return errOut(
        sessionId,
        `provider "${input.args.provider ?? provider}" does not match session ${sessionId}'s provider "${resumed.state.provider}"; fix the settings or start a new session`,
        { kind: "usage" },
        warnings,
      );
    }
    if (input.args.model !== undefined && resumed.state.model !== "" && input.args.model !== resumed.state.model) {
      return errOut(
        sessionId,
        `model "${input.args.model}" does not match session ${sessionId}'s model "${resumed.state.model}"; fix the settings or start a new session`,
        { kind: "usage" },
        warnings,
      );
    }
    if (input.args.model === undefined && resumed.state.model !== "" && model !== resumed.state.model) {
      warnings.push(`resuming with stored model "${resumed.state.model}" (config specifies "${model}")`);
      effectiveModel = resumed.state.model;
    }
  }
  const opened = await openSession({
    ...loc,
    clock: input.clock,
    ids: input.ids,
    pid: input.pid,
    host: input.host,
    secrets: [secretValue, ...outputSecrets().map((s) => s.value)],
  });
  if (opened.mode !== "write")
    return errOut(sessionId, `session ${sessionId} is read-only (${opened.reason})`, { kind: "error" }, warnings);
  const writer = opened.writer;
  let sandbox: SandboxService | undefined;
  // Attached before readSession: the lock exists now, so a signal during the read can still flush and close.
  const events: EventEnvelope[] = [];
  let shuttingDown = false;
  let shellSnapshot: ShellSnapshot | undefined;
  const ledger = new DailyLedger({ dir: `${input.dirs.data}/budget`, session: sessionId, now: input.clock.now });
  let ledgerWarned = false;
  const ledgerFailed = (err: unknown): void => {
    if (ledgerWarned) return;
    ledgerWarned = true;
    warnings.push(`the daily budget ledger could not be updated: ${err instanceof Error ? err.message : String(err)}`);
  };
  input.onSession?.({
    // A stop signal closes the log before it aborts the turn: the writes the abort still unwinds with are dropped.
    shutdown: () => {
      shuttingDown = true;
      return writer.close();
    },
    eventTypes: () => events.map((e) => e.type),
  });
  try {
    const prior = (await readSession(loc)).events;
    for (const e of prior) events.push(e);
    const push = (
      type: Parameters<typeof writer.append>[0]["type"],
      epoch: number,
      turn: number | null,
      data: unknown,
    ): void => {
      if (shuttingDown) return;
      events.push(writer.append({ type, epoch, turn, data }));
    };
    const flushLog = (): Promise<void> => (shuttingDown ? Promise.resolve() : writer.flush());
    const isNew = resumed.lines === 0;
    const shellChoice = await input.platform.resolveShell(input.settings.settings.shell);
    shellSnapshot =
      shellChoice === undefined ||
      shellChoice.kind === "powershell" ||
      input.settings.settings.shell?.snapshot === false
        ? undefined
        : startShellSnapshot({
            platform: input.platform,
            userShell: (input.os === "win32" ? undefined : input.env.SHELL) ?? shellChoice.path,
            cwd: input.cwd as AbsPath,
            env: input.env,
            sessionDir: sessionPaths(loc).dir,
            group: `snapshot:${sessionId}`,
          });
    const defs =
      input.toolDefs ??
      headlessToolDefs({
        shell: shellChoice,
        tmpDir: `${input.dirs.data}/tmp`,
        snapshot: shellSnapshot,
        offline: input.args.offline,
        ...(search?.tool === undefined ? {} : { search: search.tool }),
      });
    const parsers = await loadShellParsers().catch(() => undefined);
    const home = input.env.HOME ?? input.env.USERPROFILE ?? "/tmp";
    const resumedFrom = resumed.lines > 0 && resumed.state.mode !== "" ? resumed.state.mode : undefined;
    const planDirectory = snapshot.loaded.settings.plan?.directory;
    const projectPlans =
      planDirectory === undefined || planDirectory === "" ? undefined : projectPlanDir(loc, planDirectory);
    if (projectPlans === undefined && planDirectory !== undefined && planDirectory !== "")
      warnings.push(
        `plan.directory "${planDirectory}" is not inside the project (or is in .git): plans go in the session's own folder`,
      );
    let planFile: string | undefined = resumed.lines > 0 ? (resumed.state.planFile ?? undefined) : undefined;
    if (planFile !== undefined && !planFileAllowed(loc, planFile, projectPlans)) {
      warnings.push(
        `ignored the logged plan file ${planFile}: it is not in this session's plan folder or plan.directory`,
      );
      planFile = undefined;
    }
    let planAnnounced = planFile !== undefined;
    const ensurePlanFile = (): string => {
      planFile ??= newPlanFile(loc, planDirectory, input.prompt);
      return planFile;
    };
    const announcePlanFile = (epoch: number, turnNo: number | null): void => {
      if (planAnnounced || planFile === undefined) return;
      planAnnounced = true;
      push("settings.change", epoch, turnNo, { key: PLAN_FILE_KEY, old: null, new: planFile, source: "plan" });
    };
    if (mode === "plan") ensurePlanFile();
    const policyEnv = {
      get planFile(): string | undefined {
        return planFile;
      },
      os: input.os,
      home,
      cwd: input.cwd,
      workingDirs: [input.projectRoot] as readonly string[],
      canonicalize: (p: string) => canonicalizePath(p, input.cwd as AbsPath, input.os),
      pid: input.pid,
      ppid: input.pid,
      selfNames: ["dovet", "bun"] as readonly string[],
    };
    if (defs.some((d) => SHELL_TOOLS.includes(d.name)) && input.settings.settings.sandbox?.enabled !== false) {
      const rg = input.platform.libexec("rg");
      const rgPath = await stat(rg).then(
        () => rg,
        (err: unknown) => (isErrno(err, "ENOENT", "ENOTDIR") ? undefined : Promise.reject(err)),
      );
      sandbox = createSandboxService({
        os: input.os,
        srtDir: input.platform.libexec("srt"),
        rgPath,
        settings: input.settings.settings,
        workingDirs: [input.projectRoot],
        sessionId,
        configDir: input.dirs.config,
        dataDir: input.dirs.data,
        home,
        getMode: () => mode,
        ...(input.sandboxStarter === undefined ? {} : { starter: input.sandboxStarter }),
      });
    }
    // A rule set that fails to compile is reported below; until then no instruction file counts as readable.
    let instructionRules = ((): RuleSet | undefined => {
      try {
        return ruleSetFromSettings({
          loaded: snapshot.loaded,
          env: policyEnv,
          parsers: parsers as never,
          ruleContext: { os: input.os, home, canonicalize: policyEnv.canonicalize },
          configDir: input.dirs.config,
        }).rules;
      } catch (err) {
        if (err instanceof SettingsError) return undefined;
        throw err;
      }
    })();
    const instructionContext: InstructionContext = {
      os: input.os,
      home: home as AbsPath,
      configDir: input.dirs.config as AbsPath,
      cwd: input.cwd as AbsPath,
      projectRoot: input.projectRoot as AbsPath,
      additionalDirs: [],
      settings: input.settings.settings.instructions ?? {},
      contextWindow: input.contextWindow ?? PLACEHOLDER_CONTEXT_WINDOW,
      blockReadsOutsideWorkingDirectories:
        input.settings.settings.permissions?.blockReadsOutsideWorkingDirectories === true,
      readDenied: (canonical) =>
        instructionRules === undefined ||
        decide(
          { tool: "Read", action: { kind: "read", paths: [canonical] } },
          { mode, rules: instructionRules, env: policyEnv, tainted: false },
        ).behavior === "deny",
      approvals: skipUnapproved(
        externalImportApprovals(
          `${input.dirs.data}/projects/${projectId(input.projectRoot, input.os)}/external-imports.json`,
        ),
      ),
      askExternal: () => Promise.resolve(false),
    };
    const known = prior
      .filter((e) => e.type === "instructions.loaded")
      .map((e) => InstructionsLoadedData.parse(e.data));
    const instructions = await discoverInstructions(instructionContext, { loaded: known });
    known.push(instructions.launchEvent);
    warnings.push(...instructions.warnings);
    let launchFiles: LoadedInstruction[] = instructions.files;
    // Launch files dropped mid-turn stay watched, so one restored with its old text is announced again.
    const droppedFiles = new Map<string, DroppedFile>();
    let header: RenderInput["header"];
    let params: RenderInput["params"];
    const cache: RenderInput["cache"] = { breakpoints: "auto", ttl: "auto" };
    let epochNum: number;
    let turn: number;
    // Also re-run at every compaction, so the environment block shows the branch and date of that moment.
    const renderSystemNow = async (): Promise<string> => {
      const gitPath = await input.platform.resolve("git").catch(() => undefined);
      const git =
        gitPath === undefined
          ? null
          : await readGitHead({ git: gitPath, cwd: input.cwd as AbsPath, env: input.env }).catch(() => null);
      return renderSystemPrompt(
        {
          mode,
          ...(planFile === undefined ? {} : { planFile }),
          sandbox: input.settings.settings.sandbox?.enabled !== false,
          headless: true,
          webSearch: defs.some((d) => d.name === "WebSearch"),
          attribution: input.settings.settings.git?.attribution ?? "none",
          modelName: model,
        },
        {
          os: input.os,
          shellTool: shellToolName(shellChoice),
          workspaceRoot: input.projectRoot,
          git,
          date: sessionDate(input.clock.now()),
          model,
          provider,
        },
        launchFiles.map((f) => ({ displayPath: f.displayPath, content: f.content })),
      );
    };
    if (isNew) {
      const toolsJson = serializeTools(defs.map(toToolDef));
      const systemText = await renderSystemNow();
      const started = startEpoch({
        epoch: 0,
        reason: "session-start",
        provider,
        model,
        systemText,
        toolsJson,
        thinking: { mode: "off" },
      });
      header = started.header;
      params = { maxTokens: 4096, ...(effort === undefined ? {} : { effort }) };
      push("session.start", 0, null, { mode });
      push("epoch.start", 0, null, started.event);
      announcePlanFile(0, null);
      if (instructions.launchEvent.files.length > 0 || instructions.launchEvent.warnings.length > 0)
        push("instructions.loaded", 0, null, instructions.launchEvent);
      push("user.message", 0, 1, { text: input.prompt });
      epochNum = 0;
      turn = 1;
    } else {
      for (const r of resumed.repairs) push(r.type, r.epoch, r.turn, r.data);
      if (input.args.repair) {
        const ev = repairEpochEvent(resumed.state);
        push("epoch.start", ev.epoch, null, ev.data);
        warnings.push(
          `repair epoch ${ev.epoch} started (reasoning dropped, one cache miss). Nothing in the log was edited.`,
        );
        epochNum = ev.epoch;
      } else {
        epochNum = resumed.state.epoch;
      }
      if (resumed.repairs.length > 0 && input.args.repair !== true)
        warnings.push("crash recovery applied as new events.");
      const toolsJson =
        resumed.state.toolsJson !== "" && resumed.state.toolsJson !== "[]" ? resumed.state.toolsJson : "[]";
      const systemText = resumed.state.systemText !== "" ? resumed.state.systemText : "headless";
      const currentToolsJson = serializeTools(defs.map(toToolDef));
      if (toolsJson !== "[]" && toolsJson !== currentToolsJson) {
        try {
          const storedNames = (JSON.parse(toolsJson) as { name: string }[]).map((t) => t.name);
          const currentNames = defs.map((d) => d.name);
          const added = currentNames.filter((n) => !storedNames.includes(n));
          const removed = storedNames.filter((n) => !currentNames.includes(n));
          const diffParts: string[] = [];
          if (added.length > 0) diffParts.push(`added ${added.join(", ")}`);
          if (removed.length > 0) diffParts.push(`removed ${removed.join(", ")}`);
          if (diffParts.length === 0) diffParts.push("definitions modified");
          warnings.push(
            `settings differ from session: tools ${diffParts.join("; ")}; replaying stored definitions in current epoch.`,
          );
        } catch {
          warnings.push("settings differ from session: tools differ; replaying stored definitions in current epoch.");
        }
      }
      const charCount =
        toolsJson.length +
        systemText.length +
        prior.reduce((acc, e) => {
          const d = e.data as { text?: string };
          return acc + (typeof d?.text === "string" ? d.text.length : 0);
        }, 0);
      const estTokens = Math.round(charCount / 4);
      if (estTokens >= 8000 || prior.length >= 50) {
        const estCost = (estTokens * 0.000002).toFixed(4);
        warnings.push(
          `cold large session: cache expired; estimated full re-read cost ~$${estCost}. Consider /compact.`,
        );
      }
      header = {
        epoch: epochNum,
        provider,
        model: effectiveModel,
        promptVersion: resumed.state.promptVersion !== "" ? resumed.state.promptVersion : "0".repeat(64),
        systemText,
        toolsJson,
        thinking: resumed.state.thinking,
      };
      params = { maxTokens: 4096, ...(effort === undefined ? {} : { effort }) };
      turn = resumed.state.turn + 1;
      for (const part of instructions.resumeUpdates)
        push("system.injected", epochNum, turn, { text: part.text, reason: part.reason, delivery: "reminder-block" });
      if (instructions.resumeUpdates.length > 0) push("instructions.loaded", epochNum, null, instructions.launchEvent);
      announcePlanFile(epochNum, turn);
      if (planFile !== undefined && forkedPlanUnannounced(events)) {
        const text = await readFile(planFile, "utf8").catch((err: unknown) =>
          isErrno(err, "ENOENT") ? null : Promise.reject(err),
        );
        const part = planReattach(planFile, text);
        push("system.injected", epochNum, turn, { text: part.text, reason: part.reason, delivery: "reminder-block" });
      }
      if (flagMode !== undefined && resumedFrom !== undefined && resumedFrom !== mode) {
        push("settings.change", epochNum, turn, { key: "mode", old: resumedFrom, new: mode, source: "flag" });
        for (const part of modeChangeInstructions(resumedFrom as PermissionMode, mode, planFile))
          push("system.injected", epochNum, turn, { text: part.text, reason: part.reason, delivery: "reminder-block" });
      }
      push("user.message", epochNum, turn, { text: input.prompt });
    }

    const registry = createToolRegistry(defs);
    // A malformed rule set fails the run closed (permissions §3.1): guessing would run tools under wrong rules.
    let rules: RuleSet;
    try {
      const compiled = ruleSetFromSettings({
        loaded: snapshot.loaded,
        env: policyEnv,
        parsers: parsers as never,
        ruleContext: { os: input.os, home, canonicalize: policyEnv.canonicalize },
        configDir: input.dirs.config,
      });
      rules = compiled.rules;
      warnings.push(...compiled.warnings.map((w) => w.message));
    } catch (err) {
      const problems = err instanceof SettingsError ? err.problems.map(describeProblem).join("; ") : String(err);
      push("turn.end", epochNum, turn, { reason: "error" });
      await flushLog();
      return errOut(sessionId, `invalid settings: ${problems}`, { kind: "usage" }, warnings);
    }
    let effectiveSettings = snapshot.loaded.settings;
    const readState = createReadState(input.os);
    const baseSignal = input.signal ?? new AbortController().signal;
    const sessionTaint: string[] = resumed.lines > 0 ? [...resumed.state.taint] : [];
    const taintFrom = (sources: readonly string[]): void => {
      for (const source of sources) {
        if (sessionTaint.includes(source)) continue;
        sessionTaint.push(source);
        push("taint.change", epochNum, turn, { source, tainted: true });
      }
    };
    taintFrom(instructions.taintSources);
    const imageLimits = imageSupport(
      { imageModels: ep?.imageModels ?? [], imageLongEdge: ep?.imageLongEdge, quirks: ep?.quirks ?? {} },
      model,
      effectiveSettings.models?.[model],
    );
    const mediaBudget = createMediaBudget(events, () => epochNum, {
      requestCapBytes: requestCapFor(provider),
      maxImages: imageLimits.maxImages,
    });
    const pdfLimits = pdfSupport(
      { pdfModels: ep?.pdfModels ?? [], pdfMaxPages: ep?.pdfMaxPages },
      model,
      effectiveSettings.models?.[model],
    );
    const mediaContext: MediaContext = {
      images: imageLimits.images,
      longEdge: imageLimits.longEdge,
      pdfs: pdfLimits.pdfs,
      pdfMaxPages: pdfLimits.maxPages,
      claim: (bytes, kind) => mediaBudget.claim(bytes, kind),
      store: (bytes) => blobs.putSync(bytes),
    };
    const checkpoints = await openCheckpoints({
      workspace: input.projectRoot,
      projectDir: `${input.dirs.data}/projects/${projectId(input.projectRoot, input.os)}`,
      session: sessionId,
      env: input.env,
      platform: input.os,
      blobs,
      enabled: snapshot.loaded.settings.checkpoints?.enabled !== false,
      record: (data) => push("checkpoint", epochNum, turn, data),
    });
    checkpoints.beginTurn(turn);
    const baseCtx: ToolContext = {
      session: {
        id: sessionId,
        cwd: input.cwd as AbsPath,
        workingDirs: [input.projectRoot as AbsPath],
        mode,
        taint: sessionTaint,
        interactive: false,
      },
      settings: effectiveSettings,
      signal: baseSignal,
      readState,
      readResults: { lookup: () => undefined },
      contextFreeTokens: 200_000,
      recordWrite: (path, before) => checkpoints.recordWrite(path, before),
      shellNotice: () => checkpoints.shellNotice(),
      emit: () => undefined,
      platform: input.platform as never,
      env: input.env as never,
      ...(sandbox === undefined ? {} : { sandbox }),
      media: mediaContext,
      ...(input.searchComplete === undefined
        ? {}
        : { model: { id: `${provider}/${model}`, complete: input.searchComplete } }),
    };

    const guards = new GuardTracker();
    if (resumed.lines > 0) guards.cost = resumed.state.costUsd;
    const costOut = (): number | null => (guards.cost > 0 ? Number(guards.cost.toFixed(6)) : null);
    const maxRequests = input.args.maxRequests ?? MAX_REQUESTS_PER_TURN;
    const endpoint = record === undefined ? undefined : endpointOf(record);
    const protocol = configured?.protocol ?? endpoint?.protocol ?? "openai-chat";
    const meter = new BudgetMeter(budgetLimits(input.args.budget, effectiveSettings.budget), {
      sessionUsd: guards.cost,
      sessionTokens: 0,
    });
    let lastTokens: TokenTotals | null = null;
    let lastBodyChars: number | null = null;
    const outputTokens: number[] = [];
    let requestSeq = 0;
    const budgetEvent = (data: BudgetEventData): void => {
      push("budget.event", epochNum, turn, BudgetEventData.parse(data));
      if (data.kind === "warn")
        warnings.push(
          `${data.scope} budget at 80% (${data.spent.toFixed(data.scope === "tokens" ? 0 : 2)} of ${data.limit})`,
        );
    };
    // cli-config "Live settings reload": one poll+apply shared by the turn top and every tool batch.
    const pollAndApply = async (): Promise<void> => {
      const poll = await pollSettings(snapshot, input.loadInput);
      snapshot = poll.snapshot;
      for (const change of poll.events)
        push("settings.change", epochNum, turn, { key: change.key, old: change.old, new: change.new, source: "file" });
      warnings.push(...poll.notices, ...poll.warnings.map(describeProblem));
      if (poll.changed) {
        effectiveSettings = poll.settings;
        try {
          const compiled = ruleSetFromSettings({
            loaded: poll.loaded,
            env: policyEnv,
            parsers: parsers as never,
            ruleContext: { os: input.os, home, canonicalize: policyEnv.canonicalize },
            configDir: input.dirs.config,
          });
          rules = compiled.rules;
          instructionRules = compiled.rules;
          warnings.push(...compiled.warnings.map((w) => w.message));
        } catch (err) {
          const problems = err instanceof SettingsError ? err.problems.map(describeProblem).join("; ") : String(err);
          warnings.push(`Settings change kept the previous rules: ${problems}`);
        }
      }
    };
    let usage: Record<string, unknown> = {};
    let prevCache: number | undefined;
    let prevTurn = 0;
    let emptyRetries = 0;
    let refusalRetries = 0;
    let pauseContinuations = 0;
    let openTasksContinuations = 0;

    const buildCtx = (): ToolContext => ({
      ...baseCtx,
      session: { ...baseCtx.session, mode },
      ...(checkpoints.shell === undefined ? {} : { snapshots: checkpoints.shell }),
      settings: effectiveSettings,
      readResults: buildReadResultsIndex(events, epochNum),
      policy: {
        rules,
        mode,
        env: policyEnv as never,
        ...(parsers === undefined ? {} : { parsers }),
      },
    });
    let ctx = buildCtx();
    const modeChangedBy = new Set<string>();
    /** A tool asked for a mode (EnterPlanMode): logged, told to the model, and in force for the calls after it. */
    const applyResultMode = (r: ExecutedResult): void => {
      for (const eff of r.output.meta?.effects ?? []) {
        if (eff.kind !== "set-mode" || modeChangedBy.has(r.callId) || eff.mode === mode) continue;
        modeChangedBy.add(r.callId);
        const from = mode;
        const next = eff.mode === "auto" ? "default" : eff.mode;
        mode = next;
        if (next === "plan") ensurePlanFile();
        announcePlanFile(epochNum, turn);
        push("settings.change", epochNum, turn, { key: "mode", old: from, new: next, source: "tool" });
        for (const part of modeChangeInstructions(from, next, planFile))
          push("system.injected", epochNum, turn, { text: part.text, reason: part.reason, delivery: "reminder-block" });
        ctx = buildCtx();
      }
    };
    const decideFn = (name: string, value: unknown): { behavior: "allow" | "ask" | "deny"; reason: string } => {
      if (input.args.offline && (name === "WebFetch" || name === "WebSearch"))
        return { behavior: "deny", reason: offlineRefusal(name as "WebFetch" | "WebSearch") };
      if (input.args.disallowedTools.includes(name))
        return { behavior: "deny", reason: "disallowed by --disallowedTools" };
      if (input.args.allowedTools.includes(name)) return { behavior: "allow", reason: "allowed by --allowedTools" };
      const prep = registry.prepare(name, value);
      if (!prep.ok) return { behavior: "deny", reason: prep.message };
      const decideState = (): State => ({
        mode,
        rules,
        env: policyEnv,
        tainted: sessionTaint.length > 0,
        ...(sessionTaint.length > 0 ? { taintSource: sessionTaint[0] } : {}),
      });
      try {
        const desc = prep.tool.describeAction(prep.input as never, ctx);
        if (desc.kind === "read" || desc.kind === "edit") {
          const d = decide({ tool: name, action: { kind: desc.kind, paths: [...desc.paths] } }, decideState());
          return d.behavior === "allow"
            ? { behavior: "allow", reason: d.reason }
            : d.behavior === "deny"
              ? { behavior: "deny", reason: d.reason }
              : { behavior: "ask", reason: d.reason };
        }
        if (desc.kind === "shell") {
          if (parsers === undefined) return { behavior: "ask", reason: "no shell parsers" };
          const analysis = analyzeShell(parsers, desc.shell === "powershell" ? "powershell" : "bash", desc.command, {
            cwd: policyEnv.cwd,
            workingDirs: [...policyEnv.workingDirs],
            home: policyEnv.home,
            glob: expandGlob,
            isDirectory,
          });
          const d = decide(
            {
              tool: name,
              action: { kind: "shell", analysis, sandboxed: desc.sandboxed },
              input: { command: desc.command, dangerouslyDisableSandbox: desc.unsandboxedRetry },
            },
            decideState(),
          );
          return d.behavior === "allow"
            ? { behavior: "allow", reason: d.reason }
            : d.behavior === "deny"
              ? { behavior: "deny", reason: d.reason }
              : { behavior: "ask", reason: d.reason };
        }
        if (desc.kind === "network") {
          if (input.args.offline) {
            return {
              behavior: "deny",
              reason:
                name === "WebFetch" || name === "WebSearch"
                  ? offlineRefusal(name)
                  : `${name} is disabled in --offline mode; only model requests leave the machine.`,
            };
          }
          const d = decide({ tool: name, action: { kind: "network", host: desc.host } }, decideState());
          return d.behavior === "allow"
            ? { behavior: "allow", reason: d.reason }
            : d.behavior === "deny"
              ? { behavior: "deny", reason: d.reason }
              : { behavior: "ask", reason: d.reason };
        }
        if (desc.kind === "interaction") return { behavior: "ask", reason: "needs the user's answer" };
        return { behavior: "allow", reason: "task list" };
      } catch (err) {
        return { behavior: "deny", reason: err instanceof Error ? err.message : String(err) };
      }
    };
    const runTool = (tool: ToolDefinition<unknown>, value: unknown, c: ToolContext): Promise<ToolOutput> =>
      (tool.run as (v: unknown, ctx: ToolContext) => Promise<ToolOutput>)(value, c);
    const runEarly = async (tool: ToolDefinition<unknown>, value: unknown): Promise<ToolOutput> => {
      try {
        return await runTool(tool, value, ctx);
      } catch (err) {
        return { status: "error", content: [{ kind: "text", text: err instanceof Error ? err.message : String(err) }] };
      }
    };
    const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
      });
    // Turn-scoped: `cancelled` means no output anywhere in the turn — an abort on a follow-up request does not relabel it.
    let sawOutput = false;

    let contextMark: ContextMark | null = null;
    let forcedSinceResponse = false;
    const contextWindow = input.contextWindow ?? PLACEHOLDER_CONTEXT_WINDOW;
    const sendSummary: SendSummary = async (transcript) => {
      let finished: Extract<StreamEvent, { type: "done" }> | undefined;
      let failure = "the model returned no answer";
      for await (const e of callModel(
        { header, params, transcript, cache },
        { adapter, sleep, random: () => 0 },
        { signal: baseSignal },
      )) {
        if (e.type === "done") finished = e;
        else if (e.type === "failed") failure = e.error.message;
        else if (e.type === "aborted") return { ok: false, message: "stopped", aborted: true };
      }
      if (finished === undefined) return { ok: false, message: failure, aborted: false };
      const requestUsage = jsonSafeUsage({ ...(finished.stored.usage as Record<string, unknown>) });
      usage = addUsage(usage, requestUsage);
      const spend = responseSpend({
        protocol,
        model: header.model,
        usage: requestUsage,
        billing: endpoint?.billing ?? "per-token",
      });
      guards.cost += spend.usd;
      const t = spend.tokens;
      meter.record("compaction", spend.usd, t.input + t.cacheRead + t.cacheWrite + t.output);
      return { ok: true, stored: finished.stored, stopReason: finished.stopReason, costUsd: spend.usd };
    };
    /** Starts the next epoch from a summary of this one; false if the user stopped the summary request. */
    const compactEpoch = async (trigger: "auto" | "context-exceeded", tokensBefore: number): Promise<boolean> => {
      const result = await compact({
        events,
        header,
        params,
        cache,
        trigger,
        window: contextWindow,
        imageTokens: DEFAULT_IMAGE_TOKENS,
        tokensBefore,
        facts: {
          mode,
          tainted: sessionTaint,
          grants: [],
          workingDirs: [input.projectRoot],
          plan:
            planFile === undefined
              ? null
              : {
                  path: planFile,
                  text: await readFile(planFile, "utf8").catch((err: unknown) =>
                    isErrno(err, "ENOENT") ? null : Promise.reject(err),
                  ),
                },
        },
        renderSystem: renderSystemNow,
        send: sendSummary,
      });
      if ("aborted" in result) return false;
      const next = result.epochStart.epoch;
      push("epoch.start", next, null, result.epochStart);
      push("compaction", next, null, result.compaction);
      if (result.pending !== null) push("user.message", next, result.pending.turn, { text: result.pending.text });
      epochNum = next;
      header = headerOf(result.epochStart);
      contextMark = null;
      lastTokens = null;
      lastBodyChars = null;
      warnings.push(
        result.notice ??
          `context compacted (${trigger}): about ${result.compaction.tokensBefore} → ${result.compaction.tokensAfter} tokens.`,
      );
      return true;
    };
    const stoppedDuringCompaction = async (): Promise<HeadlessRunOutput> => {
      push("turn.end", epochNum, turn, { reason: sawOutput ? "interrupted" : "cancelled" });
      await flushLog();
      return {
        sessionId,
        result: "",
        stopReason: "interrupted",
        incomplete: false,
        usage,
        cost: costOut(),
        receipt: {},
        exit: { kind: "signal", signal: "SIGINT" },
        warnings,
      };
    };

    meter.startTurn();
    for (;;) {
      await pollAndApply();
      ctx = buildCtx();
      if (await instructionFilesMoved(launchFiles, droppedFiles)) {
        // The full discovery again, so a changed file passes the same policy, size and hidden-character checks as at launch.
        // Modification times are read before discovery: a file restored while it runs then reads as changed next time.
        const seenAt = new Map<string, number | null>();
        for (const path of [...launchFiles.map((f) => f.path), ...[...droppedFiles.values()].map((d) => d.path)])
          seenAt.set(path, await mtimeOf(path));
        // The one boundary for everything the agent can do to the filesystem mid-turn. A failed reload keeps what already
        // passed every check (user-level files included) and changes nothing: dropping files would silently lift the user's rules.
        const fresh = await discoverInstructions(instructionContext, { loaded: known }).catch((err: unknown) => {
          const why = err instanceof Error ? err.message : String(err);
          const warning = `instruction files could not be re-read (${why}); the earlier ones stay in force`;
          if (!warnings.some((w) => w.startsWith("instruction files could not be re-read"))) warnings.push(warning);
          return null;
        });
        if (fresh !== null) {
          const kept = new Set(fresh.files.map((f) => pathKey(f.path, input.os)));
          const dropped = launchFiles.filter((f) => !kept.has(pathKey(f.path, input.os)));
          for (const key of kept) droppedFiles.delete(key);
          for (const f of dropped)
            droppedFiles.set(pathKey(f.path, input.os), { path: f.path, mtimeMs: seenAt.get(f.path) ?? null });
          for (const d of droppedFiles.values()) d.mtimeMs = seenAt.get(d.path) ?? null;
          const event = { ...fresh.launchEvent, dropped: dropped.map((f) => f.path) };
          known.push(event);
          launchFiles = fresh.files;
          warnings.push(...fresh.warnings.filter((w) => !warnings.includes(w)));
          taintFrom(fresh.taintSources);
          const updates = [
            ...fresh.resumeUpdates,
            ...dropped.map((f) =>
              instructionsUpdated(f.displayPath, "(the file was deleted or can no longer be loaded)"),
            ),
          ];
          for (const part of updates)
            push("system.injected", epochNum, turn, {
              text: part.text,
              reason: part.reason,
              delivery: "reminder-block",
            });
          if (updates.length > 0) push("instructions.loaded", epochNum, null, event);
        }
      }
      const rebuild = (): ReturnType<typeof buildRequest> =>
        buildRequest(events, { header, params, cache, ...(input.args.repair ? { repair: true } : {}) });
      let built = rebuild();
      const contextTokens = (): number =>
        estimateContext({
          mark: contextMark,
          transcript: built.transcript,
          fixedChars: header.systemText.length + header.toolsJson.length,
          imageTokens: DEFAULT_IMAGE_TOKENS,
        });
      const overThreshold = (tokens: number): boolean =>
        shouldCompact({
          tokens,
          window: contextWindow,
          reserve: params.maxTokens,
          threshold: effectiveSettings.compaction?.threshold ?? 0.9,
          maxTokens: effectiveSettings.compaction?.maxTokens ?? null,
        });
      // Never between a tool call and its result: those turns wait until the round's results are logged.
      if (!hasOpenRound(built.transcript) && overThreshold(contextTokens())) {
        if (!(await compactEpoch("auto", contextTokens()))) return stoppedDuringCompaction();
        built = rebuild();
        const thrash = guards.noteCompaction(overThreshold(contextTokens()));
        if (thrash !== null) {
          push("turn.end", epochNum, turn, { reason: "error" });
          await flushLog();
          return {
            sessionId,
            result: thrash.message,
            stopReason: "error",
            incomplete: true,
            usage,
            cost: costOut(),
            receipt: {},
            exit: { kind: "guard" },
            warnings,
            events,
          };
        }
      }
      try {
        validateTranscriptItems(
          built.transcript.map((t) =>
            t.kind === "assistant"
              ? {
                  kind: "assistant",
                  stored: {
                    parts: t.stored.parts.map((p) => {
                      if (p.kind === "text") return { kind: "text", text: p.text };
                      if (p.kind === "reasoning") {
                        const summary = p.summary ?? undefined;
                        return summary === undefined ? { kind: "reasoning" } : { kind: "reasoning", summary };
                      }
                      return { kind: p.kind };
                    }),
                  },
                }
              : t.kind === "user"
                ? {
                    kind: "user",
                    parts: t.parts.map((p) => {
                      if (p.kind === "text") return { kind: "text", text: p.text };
                      if (p.kind === "tool_result") return { kind: "tool_result", content: p.content };
                      return { kind: p.kind };
                    }),
                  }
                : { kind: t.kind },
          ),
        );
        const pairing = checkTranscriptPairing(built.transcript);
        if (pairing !== null) throw new Error(`InvariantViolation: ${pairing}. Repair: ${REPAIR_HINT}`);
      } catch (err) {
        push("turn.end", epochNum, turn, { reason: "error" });
        await flushLog();
        return {
          sessionId,
          result: err instanceof Error ? err.message : String(err),
          stopReason: "error",
          incomplete: false,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      const call = adapter.render({ header, params, transcript: built.transcript, cache });
      const fingerprint = prefixFingerprint(call);
      const messageCount = (call.messages as unknown[]).length;
      const bodyText = modelRequestBody(call);
      meter.limits = budgetLimits(input.args.budget, effectiveSettings.budget);
      const estimate = estimateRequest({
        last: lastTokens,
        newChars: lastBodyChars === null ? bodyText.length : bodyText.length - lastBodyChars,
        outputs: outputTokens,
        rates: PLACEHOLDER_RATES,
      });
      requestSeq += 1;
      const requestId = `${sessionId}.${requestSeq}`;
      let budgetStop = meter.check({
        usd: estimate.usd,
        tokens: estimate.inputTokens + estimate.cacheReadTokens + estimate.outputTokens,
      });
      let reserved = false;
      if (budgetStop === null) {
        try {
          const r = await ledger.reserve(requestId, estimate.usd, meter.limits.day);
          reserved = r.ok;
          if (!r.ok) budgetStop = meter.dayStop(r.daySpent, estimate.usd);
          else for (const w of meter.warnings(r.daySpent)) budgetEvent(w);
        } catch (err) {
          if (meter.limits.day !== null)
            budgetStop = {
              scope: "day",
              spent: 0,
              limit: meter.limits.day,
              estimate: estimate.usd,
              message: `The daily budget cannot be checked (${err instanceof Error ? err.message : String(err)}).`,
            };
          else ledgerFailed(err);
        }
      }
      const pre = guards.beforeRequest(bodyText, budgetStop !== null, maxRequests);
      if (reserved && ("pause" in pre || pre.doomed)) {
        reserved = false;
        await ledger.release(requestId).catch(ledgerFailed);
      }
      if ("doomed" in pre && pre.doomed) {
        push("turn.end", epochNum, turn, { reason: "error" });
        await flushLog();
        return {
          sessionId,
          result: "Not sending a request identical to one that just failed without retry.",
          stopReason: "error",
          incomplete: false,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "error" },
          warnings,
          events,
        };
      }
      if ("pause" in pre) {
        const stopped = pre.pause.guard === "budget" ? budgetStop : null;
        if (stopped !== null)
          budgetEvent({ kind: "limit-reached", scope: stopped.scope, spent: stopped.spent, limit: stopped.limit });
        push("turn.end", epochNum, turn, { reason: stopped === null ? "error" : "budget" });
        await flushLog();
        return {
          sessionId,
          result: stopped === null ? pre.pause.message : `${stopped.message} ${pre.pause.message}`,
          stopReason: "error",
          incomplete: true,
          usage,
          cost: costOut(),
          receipt: {},
          exit: pre.pause.guard === "budget" ? { kind: "budget" } : { kind: "guard" },
          warnings,
          events,
        };
      }
      let done: Extract<StreamEvent, { type: "done" }> | undefined;
      let failed: Extract<StreamEvent, { type: "error" }> | undefined;
      let aborted = false;
      let abortedCompleted: StoredResponse | null = null;
      let sawRequest = false;
      const early = new Map<string, Promise<ToolOutput>>();
      const earlyBlocks = new Map<number, { id: string; name: string; json: string }>();
      for await (const e of callModel(
        { header, params, transcript: built.transcript, cache },
        { adapter, sleep, random: () => 0 },
        { signal: baseSignal },
      )) {
        if (
          e.type === "text.delta" ||
          e.type === "reasoning.delta" ||
          e.type === "tool_call.start" ||
          e.type === "tool_call.delta"
        )
          sawOutput = true;
        if (e.type === "request") {
          sawRequest = true;
          push(
            "model.request",
            epochNum,
            turn,
            modelRequestData({
              provider: header.provider,
              model: header.model,
              ...(params.effort === undefined ? {} : { effort: params.effort }),
              maxTokens: params.maxTokens,
              messageCount,
              body: e.request.body,
              fingerprint,
            }),
          );
          guards.noteRequestSent(e.request.body);
        } else if (e.type === "done") {
          done = e;
        } else if (e.type === "failed") {
          failed = { type: "error", error: e.error, completed: null };
        } else if (e.type === "aborted") {
          aborted = true;
          abortedCompleted = e.completed;
        } else if (e.type === "usage") {
          const read = cacheReadOf(jsonSafeUsage(e.usage as Record<string, unknown>));
          const warn = cacheWarning(
            prevCache === undefined ? undefined : { turn: prevTurn, cacheReadTokens: prevCache },
            { turn, cacheReadTokens: read },
          );
          if (warn !== null) warnings.push(warn.text);
          prevCache = read;
          prevTurn = turn;
        } else if (e.type === "tool_call.start") {
          earlyBlocks.set(e.blockIndex, { id: e.id, name: e.name, json: "" });
        } else if (e.type === "tool_call.delta") {
          const block = earlyBlocks.get(e.blockIndex);
          if (block !== undefined) block.json += e.partialJson;
        } else if (e.type === "block.done" && e.kind === "tool_call") {
          const block = earlyBlocks.get(e.blockIndex);
          earlyBlocks.delete(e.blockIndex);
          if (block !== undefined && !early.has(block.id)) {
            const value = (() => {
              try {
                return JSON.parse(block.json) as unknown;
              } catch {
                return undefined;
              }
            })();
            const prep = value === undefined ? undefined : registry.prepare(block.name, value);
            if (prep?.ok === true && isEarlyEligible(block.name, decideFn(block.name, prep.input).behavior))
              early.set(block.id, runEarly(prep.tool, prep.input));
          }
        } else if (e.type === "discarded" || e.type === "kept") {
          early.clear();
        }
      }
      if (!sawRequest && !aborted) {
        const synthetic = modelRequestBody(call);
        push(
          "model.request",
          epochNum,
          turn,
          modelRequestData({
            provider: header.provider,
            model: header.model,
            ...(params.effort === undefined ? {} : { effort: params.effort }),
            maxTokens: params.maxTokens,
            messageCount,
            body: synthetic,
            fingerprint,
          }),
        );
        guards.noteRequestSent(synthetic);
      }
      if (aborted) {
        // STREAM abort keeps the blocks that completed, answers their tool calls "Not run" and stays in the transcript;
        // `cancelled` is reserved for an abort before any model output (event-log "Event types").
        const kept = abortedCompleted !== null && shouldAppendInterrupted(abortedCompleted) ? abortedCompleted : null;
        if (kept !== null) {
          push("model.response", epochNum, turn, kept);
          const keptCalls = parseToolCalls(kept.parts);
          for (const c of keptCalls) {
            const raw = (() => {
              try {
                return JSON.parse(c.rawJson);
              } catch {
                return c.rawJson;
              }
            })();
            const prep = registry.prepare(c.name, raw);
            push("tool.call", epochNum, turn, {
              callId: c.id,
              name: c.name,
              raw,
              input: prep.ok ? prep.normalized : raw,
            });
          }
          for (const r of streamInterruptResults(keptCalls))
            push("tool.result", epochNum, turn, {
              callId: r.callId,
              status: "interrupted",
              output: INTERRUPTED_NOT_RUN,
            });
          // The next user message starts with this instruction (agent-loop "Interrupts" STREAM row): logged here,
          // where the kept blocks are, so a resume's next request carries it.
          push("system.injected", epochNum, turn, {
            text: INTERRUPT_INSTRUCTION,
            reason: "interrupt-note",
            delivery: "reminder-block",
          });
        }
        push("turn.end", epochNum, turn, { reason: kept !== null || sawOutput ? "interrupted" : "cancelled" });
        await flushLog();
        return {
          sessionId,
          result: "",
          stopReason: "interrupted",
          incomplete: false,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "signal", signal: "SIGINT" },
          warnings,
        };
      }
      if (failed !== undefined) {
        guards.noteError(failed.error.retryable);
        if (isHistoryRelated(failed.error)) {
          const offer = historyRepairOffer(failed.error);
          push("turn.end", epochNum, turn, { reason: "error" });
          await flushLog();
          const hint = offer !== null ? ` ${offer.hint}` : "";
          return {
            sessionId,
            result: `${failed.error.message}${hint}`,
            stopReason: "error",
            incomplete: false,
            usage,
            cost: costOut(),
            receipt: {},
            exit: { kind: "history-rejected" },
            warnings,
          };
        }
        push("turn.end", epochNum, turn, { reason: "error" });
        await flushLog();
        return {
          sessionId,
          result: failed.error.message,
          stopReason: "error",
          incomplete: false,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      if (done === undefined) {
        push("turn.end", epochNum, turn, { reason: "error" });
        await flushLog();
        return {
          sessionId,
          result: "the model returned no answer",
          stopReason: "error",
          incomplete: false,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      const requestUsage = jsonSafeUsage({ ...(done.stored.usage as Record<string, unknown>) });
      usage = addUsage(usage, requestUsage);
      const spend = responseSpend({
        protocol,
        model: header.model,
        usage: requestUsage,
        billing: endpoint?.billing ?? "per-token",
      });
      guards.cost += spend.usd;
      const t = spend.tokens;
      meter.record("main", spend.usd, t.input + t.cacheRead + t.cacheWrite + t.output);
      lastTokens = t;
      lastBodyChars = bodyText.length;
      contextMark = { tokens: t, chars: transcriptChars(built.transcript), images: countImages(built.transcript) };
      outputTokens.push(t.output);
      const daySpent = reserved
        ? await ledger.commit(requestId, spend.usd).catch((e: unknown) => {
            ledgerFailed(e);
            return null;
          })
        : null;
      for (const w of meter.warnings(daySpent)) budgetEvent(w);
      const read = cacheReadOf(requestUsage);
      const warn = cacheWarning(prevCache === undefined ? undefined : { turn: prevTurn, cacheReadTokens: prevCache }, {
        turn,
        cacheReadTokens: read,
      });
      if (warn !== null) warnings.push(warn.text);
      prevCache = read;
      prevTurn = turn;
      const calls = parseToolCalls(done.stored.parts);
      if (shouldDiscardEarly(done.stopReason, calls.length > 0)) early.clear();
      const invalidOf = (c: ParsedCall): string | undefined => {
        let value: unknown;
        try {
          value = JSON.parse(c.rawJson);
        } catch {
          return "INVALID_JSON";
        }
        const prep = registry.prepare(c.name, value);
        return prep.ok ? undefined : prep.message;
      };
      const malformedPause = (() => {
        if (calls.length === 0) {
          guards.noteMalformedRound(false, "", false, header.model);
          return null;
        }
        if (done.stopReason === "max_tokens")
          return guards.noteMalformedRound(true, "cut off by the output limit", true, header.model);
        const bad = calls.flatMap((c) => invalidOf(c) ?? []);
        if (bad.length === calls.length)
          return guards.noteMalformedRound(true, bad[0] ?? "invalid tool call", false, header.model);
        guards.noteMalformedRound(false, "", false, header.model);
        return null;
      })();
      const hasText = done.stored.parts.some((p) => p.kind === "text" && p.text.trim() !== "");
      // Refusal and max_tokens have their own stop-reason rows; anything else with no text and no call is empty.
      const emptyOnly =
        !hasText && calls.length === 0 && done.stopReason !== "refusal" && done.stopReason !== "max_tokens";
      const truncated = done.stopReason === "max_tokens" && calls.length > 0;
      const stopInput = {
        stop: done.stopReason,
        toolCalls: calls.length,
        hasText,
        emptyOrThinkingOnly: emptyOnly,
        truncatedToolCall: truncated,
        pauseContinuations,
        emptyRetries,
        refusalRetries,
        ...(typeof done.stored.finishReason === "string" && done.stopReason === "refusal" && !hasText
          ? { refusalCategory: done.stored.finishReason, refusalBeforeOutput: true as const }
          : {}),
      };
      const action = decideStopAction(stopInput);
      if (action.kind !== "compact-retry") forcedSinceResponse = false;
      // A response with no text and no tool call is not appended (agent-loop "Stop-reason handling"), so an
      // empty or thinking-only retry sees a clean transcript and the log never holds a reasoning-only turn.
      if (hasText || calls.length > 0) {
        push("model.response", epochNum, turn, done.stored);
        // A buffered adapter may skip deltas and deliver the block only in `done`; the appended response is output.
        sawOutput = true;
      }
      const recordNotRun = (text: (c: ParsedCall) => string): void => {
        for (const c of calls) {
          const raw = (() => {
            try {
              return JSON.parse(c.rawJson);
            } catch {
              return c.rawJson;
            }
          })();
          const prep = registry.prepare(c.name, raw);
          push("tool.call", epochNum, turn, {
            callId: c.id,
            name: c.name,
            raw,
            input: prep.ok ? prep.normalized : raw,
          });
          push("tool.result", epochNum, turn, { callId: c.id, status: "error", output: text(c) });
        }
      };
      if (malformedPause !== null) {
        recordNotRun((c) => (truncated ? TRUNCATED_NOT_RUN : (invalidOf(c) ?? "invalid tool call")));
        push("turn.end", epochNum, turn, { reason: "error" });
        await flushLog();
        return {
          sessionId,
          result: malformedPause.message,
          stopReason: "error",
          incomplete: true,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "guard" },
          warnings,
        };
      }
      if (action.kind === "retry") {
        if (calls.length > 0) recordNotRun(() => REFUSAL_NOT_RUN);
        if (emptyOnly) emptyRetries += 1;
        else refusalRetries += 1;
        continue;
      }
      if (action.kind === "finalize") {
        const text = done.stored.parts
          .filter((p) => p.kind === "text")
          .map((p) => (p.kind === "text" ? p.text : ""))
          .join("");
        if (action.reason === "refusal") {
          if (calls.length > 0) recordNotRun(() => REFUSAL_NOT_RUN);
          push("turn.end", epochNum, turn, { reason: "refusal" });
          await flushLog();
          return {
            sessionId,
            result: text,
            stopReason: action.reason,
            incomplete: false,
            usage,
            cost: costOut(),
            receipt: {},
            exit: { kind: "refusal" },
            warnings,
          };
        }
        // Every tool_use needs exactly one tool_result (agent-loop "Stop-reason handling"), so a call the
        // finalize skipped is logged as not run instead of leaving the turn unpaired.
        if (calls.length > 0) recordNotRun(() => ENDED_NOT_RUN);
        const openItems = openTasksFromEvents(events);
        if (
          openItems > 0 &&
          shouldContinueForOpenTasks({
            headless: true,
            endedWithText: hasText,
            openItems,
            blockerStated: false,
            continuations: openTasksContinuations,
          })
        ) {
          openTasksContinuations += 1;
          push("user.message", epochNum, turn, {
            text: "Please continue with the remaining open tasks in your task list.",
          });
          continue;
        }
        const incomplete = openItems > 0;
        push("turn.end", epochNum, turn, { reason: "end_turn" });
        await flushLog();
        return {
          sessionId,
          result: text === "" ? (action.note ?? text) : text,
          stopReason: action.reason,
          incomplete,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "ok", ...(incomplete ? { incomplete: true } : {}) },
          warnings,
          events,
        };
      }
      if (action.kind === "prepare") {
        recordNotRun(() => TRUNCATED_NOT_RUN);
        push("user.message", epochNum, turn, { text: action.instruction });
        continue;
      }
      if (action.kind === "pause-continue") {
        pauseContinuations += 1;
        continue;
      }
      if (action.kind === "compact-retry" && !forcedSinceResponse) {
        recordNotRun(() => "Not run: the context window was full.");
        forcedSinceResponse = true;
        if (!(await compactEpoch("context-exceeded", contextTokens()))) return stoppedDuringCompaction();
        continue;
      }
      if (action.kind === "compact-retry") {
        push("turn.end", epochNum, turn, { reason: "error" });
        await flushLog();
        return {
          sessionId,
          result: "context exceeded",
          stopReason: "error",
          incomplete: false,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      const earlyResults = new Map<string, ToolOutput>();
      for (const c of calls) {
        const pending = early.get(c.id);
        if (pending !== undefined) earlyResults.set(c.id, await pending);
      }
      early.clear();
      // The tool.call goes to the log before the tool runs: an abnormal exit leaves it for resume's crash recovery.
      const recordCallEvents = (): void => {
        for (const c of calls) {
          const raw = (() => {
            try {
              return JSON.parse(c.rawJson);
            } catch {
              return c.rawJson;
            }
          })();
          const prep = registry.prepare(c.name, raw);
          push("tool.call", epochNum, turn, {
            callId: c.id,
            name: c.name,
            raw,
            input: prep.ok ? prep.normalized : raw,
          });
        }
      };
      const applyResultTaint = (r: ExecutedResult): void => {
        for (const eff of r.output.meta?.effects ?? []) {
          if (eff.kind === "taint") {
            if (!sessionTaint.includes(eff.source)) {
              sessionTaint.push(eff.source);
              push("taint.change", epochNum, turn, { source: eff.source, tainted: true });
            }
          }
        }
      };
      const recordResultEvents = (): void => {
        for (const r of results) {
          const text = r.output.content.map((x) => (x.kind === "text" ? x.text : "")).join("");
          const status =
            r.output.status === "ok"
              ? "ok"
              : r.output.status === "interrupted"
                ? "interrupted"
                : r.output.status === "denied"
                  ? "denied"
                  : r.output.status === "timeout"
                    ? "timeout"
                    : "error";
          const media = r.output.content.flatMap((x) =>
            x.kind === "text" ? [] : [{ ...x, bytes: blobs.getSync(x.blob.id)?.length ?? 0 }],
          );
          push("tool.result", epochNum, turn, {
            callId: r.callId,
            status,
            output: text,
            ...(media.length === 0 ? {} : { media }),
            ...(r.output.meta?.search === undefined ? {} : { search: r.output.meta.search }),
          });
          for (const f of r.output.meta?.fileChanges ?? []) push("file.change", epochNum, turn, f);
          applyResultTaint(r);
          applyResultMode(r);
        }
        mediaBudget.settle();
      };
      recordCallEvents();
      const { results, stopped } = await executeTools(calls, {
        registry,
        decide: decideFn,
        prompt: () => Promise.resolve({ allow: false, dontAskAgain: false }),
        run: runTool,
        makeContext: () => ctx,
        beforeBatch: async () => {
          await pollAndApply();
          ctx = buildCtx();
        },
        onResult: (r) => {
          applyResultTaint(r);
          applyResultMode(r);
        },
        offloadDir: join(sessionPaths(loc).dir, sessionId, "outputs"),
        headless: true,
        capBytes: requestCapFor(provider),
        earlyResults,
        secrets: outputSecrets,
        signal: baseSignal,
      });
      const byId = new Map(results.map((r) => [r.callId, r]));
      if (baseSignal.aborted) {
        recordResultEvents();
        push("turn.end", epochNum, turn, { reason: "interrupted" });
        await flushLog();
        return {
          sessionId,
          result: "",
          stopReason: "interrupted",
          incomplete: false,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "signal", signal: "SIGINT" },
          warnings,
        };
      }
      const guardExit = (message: string): HeadlessRunOutput => ({
        sessionId,
        result: message,
        stopReason: "error",
        incomplete: true,
        usage,
        cost: costOut(),
        receipt: {},
        exit: { kind: "guard" },
        warnings,
      });
      for (const c of calls) {
        const out = byId.get(c.id)?.output;
        if (out?.status === "ok") {
          guards.noteIdenticalSuccess();
          continue;
        }
        const text = out?.content.map((x) => (x.kind === "text" ? x.text : "")).join("") ?? "failed";
        let key: string;
        try {
          const prep = registry.prepare(c.name, JSON.parse(c.rawJson));
          key = prep.ok ? `${c.name}(${JSON.stringify(prep.normalized)})` : `${c.name}(${c.rawJson})`;
        } catch {
          key = `${c.name}(${c.rawJson})`;
        }
        const pause = guards.noteIdenticalFail(key, text);
        if (pause !== null) {
          recordResultEvents();
          push("turn.end", epochNum, turn, { reason: "error" });
          await flushLog();
          return guardExit(pause.message);
        }
      }
      const progressed =
        results.some((r) => (r.output.meta?.fileChanges?.length ?? 0) > 0) ||
        calls.some((c) => {
          const st = byId.get(c.id)?.output.status;
          if (c.name === "Bash" || c.name === "PowerShell") return true;
          return (c.name === "Read" || c.name === "Grep" || c.name === "Glob") && st === "ok";
        });
      const progressPause = guards.noteProgress(progressed);
      if (progressPause !== null) {
        recordResultEvents();
        push("turn.end", epochNum, turn, { reason: "error" });
        await flushLog();
        return guardExit(progressPause.message);
      }
      recordResultEvents();
      if (stopped) {
        const incomplete = openTasksFromEvents(events) > 0;
        push("turn.end", epochNum, turn, { reason: "end_turn" });
        await flushLog();
        const text = results
          .map((r) => r.output.content.map((x) => (x.kind === "text" ? x.text : "")).join(""))
          .join("\n");
        return {
          sessionId,
          result: text,
          stopReason: "end_turn",
          incomplete,
          usage,
          cost: costOut(),
          receipt: {},
          exit: { kind: "ok", ...(incomplete ? { incomplete: true } : {}) },
          warnings,
          events,
        };
      }
    }
  } finally {
    try {
      if (sandbox !== undefined) {
        const ranShell = events.some(
          (e) => e.type === "tool.call" && SHELL_TOOLS.includes((e.data as { name?: string }).name ?? ""),
        );
        if (ranShell) {
          await sandbox.ready;
          warnings.push(...sandbox.globWarnings());
          if (sandbox.state === "off") warnings.push(sandboxStatus(sandbox.state, sandbox.backend));
        }
        await sandbox.close();
      }
    } finally {
      if (shellSnapshot !== undefined) {
        // Stopped, not waited for: a run that ends (or is interrupted) while the rc files still run must not wait out the 10 s timeout.
        await input.platform.killTree(`snapshot:${sessionId}`);
        await shellSnapshot.ready();
      }
      await ledger.releaseOutstanding().catch(ledgerFailed);
      await writer.close();
    }
  }
}
