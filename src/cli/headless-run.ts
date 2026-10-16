// Headless agent turn (tui "Headless mode", agent-loop "Turn state machine", event-log "Resume", providers §1).
import {
  buildRequest,
  cacheReadOf,
  cacheWarning,
  decideStopAction,
  executeTools,
  GuardTracker,
  historyRepairOffer,
  MAX_REQUESTS_PER_TURN,
  modelRequestBody,
  modelRequestData,
  parseToolCalls,
  prefixFingerprint,
  renderSystemPrompt,
  serializeTools,
  sessionDate,
  startEpoch,
  toolDescription,
} from "../agent/index.ts";
import {
  callModel,
  createSdkAdapter,
  endpointOf,
  type ProviderRequest,
  providerRecord,
  type RenderInput,
  type SdkCall,
  type StreamEvent,
} from "../ai/index.ts";
import { canonicalizePath, type Os, type Platform, readGitHead } from "../platform/index.ts";
import {
  analyzeShell,
  createDotEnvSecrets,
  decide,
  expandGlob,
  isDirectory,
  loadShellParsers,
  type NamedSecret,
  type RuleSet,
  ruleSetFromSettings,
  secretsFromEnv,
} from "../policy/index.ts";
import type { AbsPath, EventEnvelope } from "../schema/index.ts";
import { PermissionMode } from "../schema/index.ts";
import {
  createCredentials,
  createSecretStore,
  isHistoryRelated,
  type LoadedSettings,
  listSessions,
  openSession,
  readSession,
  repairEpochEvent,
  resumeSession,
  Secret,
  validateTranscriptItems,
} from "../store/index.ts";
import {
  buildReadResultsIndex,
  builtinTools,
  createBashTool,
  createReadState,
  createToolRegistry,
  type ToolContext,
  type ToolDefinition,
  toolInputSchema,
} from "../tools/index.ts";
import type { HeadlessArgs } from "./args.ts";
import type { HeadlessOutcome } from "./headless-output.ts";

export type HeadlessAdapter = {
  render(input: RenderInput): SdkCall;
  stream(
    call: SdkCall,
    opts: { signal: AbortSignal; onRequest: (r: ProviderRequest) => void },
  ): AsyncIterable<StreamEvent>;
};

export type HeadlessRunInput = {
  dirs: { config: string; data: string; cache: string };
  projectRoot: string;
  cwd: string;
  os: Os;
  settings: LoadedSettings;
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
  platform: Platform;
  tmpDir: string;
  offline: boolean;
}): ToolDefinition<unknown>[] {
  const base = [...builtinTools];
  const bash =
    input.platform.os === "win32"
      ? createBashTool({ tmpDir: input.tmpDir, gitBash: true })
      : createBashTool({ tmpDir: input.tmpDir });
  return [
    ...base.filter((t) => t.name !== "Bash" && t.name !== "PowerShell" && t.name !== "AskUserQuestion"),
    bash,
  ] as ToolDefinition<unknown>[];
}

function toToolDef(
  def: ToolDefinition<unknown>,
  shellTool: string,
): { name: string; description: string; inputSchema: Record<string, unknown> } {
  let description: string;
  try {
    description = toolDescription(def.name === "Bash" && shellTool === "git-bash" ? "BashGitBash" : def.name);
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

export async function runHeadless(input: HeadlessRunInput): Promise<HeadlessRunOutput> {
  const warnings: string[] = [];
  if (input.args.repair && input.args.resume === undefined && !input.args.continued)
    return errOut("", "--repair needs --resume or --continue", { kind: "usage" }, warnings);
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

  // The output-redaction set (permissions §8, §4.7): the provider credential, secret-named env vars
  // and workspace `.env*` values, re-read regularly so edited files are picked up.
  const dotEnvSecrets = createDotEnvSecrets([input.projectRoot]);
  const outputSecrets = (): NamedSecret[] => [
    { name: "CREDENTIAL", value: secretValue },
    ...secretsFromEnv(input.env),
    ...dotEnvSecrets.current(),
  ];

  const endpointBase = {
    package: record?.endpoints[0]?.package ?? "@ai-sdk/openai-compatible",
    baseURL,
    quirks: {},
  };
  const adapter: HeadlessAdapter =
    input.adapter ??
    createSdkAdapter({
      endpoint: () => ({ ...endpointBase, baseURL, apiKey: new Secret(secretValue) }),
      modelInfo: () => ({ effortLevels: ["minimal", "low", "medium", "high", "xhigh", "max"] }),
    });

  let sessionId: string;
  if (input.args.resume !== undefined || input.args.continued) {
    const sessions = await listSessions({ data: input.dirs.data, projectRoot: input.projectRoot, os: input.os });
    if (input.args.resume !== undefined) {
      const exact = sessions.find((s) => s.id === input.args.resume);
      if (exact !== undefined) sessionId = exact.id;
      else {
        const prefixed = sessions.filter((s) => s.id.startsWith(input.args.resume ?? ""));
        if (prefixed.length === 1 && prefixed[0] !== undefined) sessionId = prefixed[0].id;
        else
          return errOut(
            "",
            prefixed.length === 0
              ? `no session matches "${input.args.resume}"`
              : `"${input.args.resume}" matches ${prefixed.length} sessions; give a longer id`,
            { kind: "usage" },
            warnings,
          );
      }
    } else {
      const latest = sessions[sessions.length - 1];
      if (latest === undefined) return errOut("", "no saved sessions for this project", { kind: "usage" }, warnings);
      sessionId = latest.id;
    }
  } else {
    sessionId = input.ids.ulid();
  }

  const loc = { data: input.dirs.data, projectRoot: input.projectRoot, os: input.os, session: sessionId };
  const resumed = await resumeSession(loc);
  warnings.push(...resumed.warnings);
  if (resumed.readOnly !== undefined)
    return errOut(sessionId, `session ${sessionId} is read-only (${resumed.readOnly})`, { kind: "error" }, warnings);
  if (resumed.lines > 0) {
    if (resumed.state.provider !== "" && provider !== resumed.state.provider)
      return errOut(
        sessionId,
        `provider "${provider}" does not match session ${sessionId}'s provider "${resumed.state.provider}"; fix the settings or start a new session`,
        { kind: "usage" },
        warnings,
      );
    if (resumed.state.model !== "" && model !== resumed.state.model)
      return errOut(
        sessionId,
        `model "${model}" does not match session ${sessionId}'s model "${resumed.state.model}"; fix the settings or start a new session`,
        { kind: "usage" },
        warnings,
      );
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
  try {
    const prior = (await readSession(loc)).events;
    const events: EventEnvelope[] = [...prior];
    const push = (
      type: Parameters<typeof writer.append>[0]["type"],
      epoch: number,
      turn: number | null,
      data: unknown,
    ): void => {
      events.push(writer.append({ type, epoch, turn, data }));
    };
    const isNew = resumed.lines === 0;
    let header: RenderInput["header"];
    let params: RenderInput["params"];
    const cache: RenderInput["cache"] = { breakpoints: "auto", ttl: "auto" };
    let epochNum: number;
    let turn: number;
    if (isNew) {
      const defs =
        input.toolDefs ??
        headlessToolDefs({ platform: input.platform, tmpDir: `${input.dirs.data}/tmp`, offline: input.args.offline });
      const toolsJson = serializeTools(
        defs.map((d) => toToolDef(d, input.platform.os === "win32" ? "git-bash" : "bash")),
      );
      const gitPath = await input.platform.resolve("git").catch(() => undefined);
      const git =
        gitPath === undefined
          ? null
          : await readGitHead({ git: gitPath, cwd: input.cwd as AbsPath, env: input.env }).catch(() => null);
      const systemText = renderSystemPrompt(
        {
          mode,
          sandbox: input.settings.settings.sandbox?.enabled !== false,
          headless: true,
          webSearch: false,
          attribution: input.settings.settings.git?.attribution ?? "none",
          modelName: model,
        },
        {
          os: input.os,
          shellTool: "Bash",
          workspaceRoot: input.projectRoot,
          git,
          date: sessionDate(input.clock.now()),
          model,
          provider,
        },
        [],
      );
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
      header = {
        epoch: epochNum,
        provider: resumed.state.provider !== "" ? resumed.state.provider : provider,
        model: resumed.state.model !== "" ? resumed.state.model : model,
        promptVersion: resumed.state.promptVersion !== "" ? resumed.state.promptVersion : "0".repeat(64),
        systemText,
        toolsJson,
        thinking: resumed.state.thinking,
      };
      params = { maxTokens: 4096, ...(effort === undefined ? {} : { effort }) };
      turn = resumed.state.turn + 1;
      push("user.message", epochNum, turn, { text: input.prompt });
    }

    const defs =
      input.toolDefs ??
      headlessToolDefs({ platform: input.platform, tmpDir: `${input.dirs.data}/tmp`, offline: input.args.offline });
    const registry = createToolRegistry(defs);
    const parsers = await loadShellParsers().catch(() => undefined);
    const home = input.env.HOME ?? input.env.USERPROFILE ?? "/tmp";
    const policyEnv = {
      os: input.os,
      home,
      cwd: input.cwd,
      workingDirs: [input.projectRoot] as readonly string[],
      canonicalize: (p: string) => canonicalizePath(p, input.cwd as AbsPath, input.os),
      pid: input.pid,
      ppid: input.pid,
      selfNames: ["dovet", "bun"] as readonly string[],
    };
    const ruleInput = (() => {
      try {
        return ruleSetFromSettings({
          loaded: input.settings,
          env: policyEnv,
          parsers: parsers as never,
          ruleContext: { os: input.os, home, canonicalize: policyEnv.canonicalize },
          configDir: input.dirs.config,
        });
      } catch {
        return undefined;
      }
    })();
    const rules: RuleSet | undefined = ruleInput?.rules;
    const readState = createReadState(input.os);
    const baseSignal = new AbortController().signal;
    const baseCtx: ToolContext = {
      session: {
        id: sessionId,
        cwd: input.cwd as AbsPath,
        workingDirs: [input.projectRoot as AbsPath],
        mode,
        taint: [],
        interactive: false,
      },
      settings: input.settings.settings,
      signal: baseSignal,
      readState,
      readResults: { lookup: () => undefined },
      contextFreeTokens: 200_000,
      recordWrite: () => Promise.resolve(),
      emit: () => undefined,
      platform: input.platform as never,
      env: input.env as never,
    };

    const guards = new GuardTracker();
    const maxRequests = input.args.maxRequests ?? MAX_REQUESTS_PER_TURN;
    let usage: Record<string, unknown> = {};
    let prevCache: number | undefined;
    let prevTurn = 0;
    let emptyRetries = 0;
    let refusalRetries = 0;
    let pauseContinuations = 0;

    for (;;) {
      const built = buildRequest(events, { header, params, cache });
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
                    parts: t.parts.map((p) => (p.kind === "text" ? { kind: "text", text: p.text } : { kind: p.kind })),
                  }
                : { kind: t.kind },
          ),
        );
      } catch (err) {
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
        await writer.flush();
        return {
          sessionId,
          result: err instanceof Error ? err.message : String(err),
          stopReason: "error",
          incomplete: false,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      const call = adapter.render({ header, params, transcript: built.transcript, cache });
      const fingerprint = prefixFingerprint(call);
      const messageCount = (call.messages as unknown[]).length;
      const pre = guards.beforeRequest(modelRequestBody(call), false, maxRequests);
      if ("doomed" in pre && pre.doomed) {
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
        await writer.flush();
        return {
          sessionId,
          result: "Not sending a request identical to one that just failed without retry.",
          stopReason: "error",
          incomplete: false,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      if ("pause" in pre) {
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
        await writer.flush();
        return {
          sessionId,
          result: pre.pause.message,
          stopReason: "error",
          incomplete: true,
          usage,
          cost: null,
          receipt: {},
          exit: pre.pause.guard === "budget" ? { kind: "budget" } : { kind: "guard" },
          warnings,
        };
      }
      let done: Extract<StreamEvent, { type: "done" }> | undefined;
      let failed: Extract<StreamEvent, { type: "error" }> | undefined;
      let aborted = false;
      let sawRequest = false;
      const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      for await (const e of callModel(
        { header, params, transcript: built.transcript, cache },
        { adapter, sleep, random: () => 0 },
        { signal: baseSignal },
      )) {
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
        } else if (e.type === "usage") {
          usage = jsonSafeUsage(e.usage as Record<string, unknown>);
          const read = cacheReadOf(usage);
          const warn = cacheWarning(
            prevCache === undefined ? undefined : { turn: prevTurn, cacheReadTokens: prevCache },
            { turn, cacheReadTokens: read },
          );
          if (warn !== null) warnings.push(warn.text);
          prevCache = read;
          prevTurn = turn;
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
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "interrupted" } });
        await writer.flush();
        return {
          sessionId,
          result: "",
          stopReason: "interrupted",
          incomplete: false,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "signal", signal: "SIGINT" },
          warnings,
        };
      }
      if (failed !== undefined) {
        guards.noteError(failed.error.retryable);
        if (isHistoryRelated(failed.error)) {
          const offer = historyRepairOffer(failed.error);
          writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
          await writer.flush();
          const hint = offer !== null ? ` ${offer.hint}` : "";
          return {
            sessionId,
            result: `${failed.error.message}${hint}`,
            stopReason: "error",
            incomplete: false,
            usage,
            cost: null,
            receipt: {},
            exit: { kind: "history-rejected" },
            warnings,
          };
        }
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
        await writer.flush();
        return {
          sessionId,
          result: failed.error.message,
          stopReason: "error",
          incomplete: false,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      if (done === undefined) {
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
        await writer.flush();
        return {
          sessionId,
          result: "the model returned no answer",
          stopReason: "error",
          incomplete: false,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      usage = jsonSafeUsage({ ...(done.stored.usage as Record<string, unknown>) });
      const read = cacheReadOf(usage);
      const warn = cacheWarning(prevCache === undefined ? undefined : { turn: prevTurn, cacheReadTokens: prevCache }, {
        turn,
        cacheReadTokens: read,
      });
      if (warn !== null) warnings.push(warn.text);
      prevCache = read;
      prevTurn = turn;
      push("model.response", epochNum, turn, done.stored);
      const calls = parseToolCalls(done.stored.parts);
      const malformedPause = (() => {
        if (calls.length === 0) {
          guards.noteMalformedRound(false, "", false, header.model);
          return null;
        }
        if (done.stopReason === "max_tokens")
          return guards.noteMalformedRound(true, "cut off by the output limit", true, header.model);
        const bad: string[] = [];
        for (const c of calls) {
          let value: unknown;
          try {
            value = JSON.parse(c.rawJson);
          } catch {
            bad.push("INVALID_JSON");
            continue;
          }
          const prep = registry.prepare(c.name, value);
          if (!prep.ok) bad.push(prep.message);
        }
        if (bad.length === calls.length)
          return guards.noteMalformedRound(true, bad[0] ?? "invalid tool call", false, header.model);
        guards.noteMalformedRound(false, "", false, header.model);
        return null;
      })();
      if (malformedPause !== null) {
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
        await writer.flush();
        return {
          sessionId,
          result: malformedPause.message,
          stopReason: "error",
          incomplete: true,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "guard" },
          warnings,
        };
      }
      const hasText = done.stored.parts.some((p) => p.kind === "text" && p.text.trim() !== "");
      const emptyOnly = done.stored.parts.length > 0 && !hasText && calls.length === 0;
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
      if (action.kind === "retry") {
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
          writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "refusal" } });
          await writer.flush();
          return {
            sessionId,
            result: text,
            stopReason: action.reason,
            incomplete: false,
            usage,
            cost: null,
            receipt: {},
            exit: { kind: "refusal" },
            warnings,
          };
        }
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "end_turn" } });
        await writer.flush();
        return {
          sessionId,
          result: text === "" ? (action.note ?? text) : text,
          stopReason: action.reason,
          incomplete: false,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "ok" },
          warnings,
        };
      }
      if (action.kind === "prepare") {
        push("system.injected", epochNum, turn, {
          text: action.instruction,
          reason: "queued-messages",
          delivery: "reminder-block",
        });
        continue;
      }
      if (action.kind === "pause-continue") {
        pauseContinuations += 1;
        continue;
      }
      if (action.kind === "compact-retry") {
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
        await writer.flush();
        return {
          sessionId,
          result: "context exceeded",
          stopReason: "error",
          incomplete: false,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "error" },
          warnings,
        };
      }
      const ctx: ToolContext = {
        ...baseCtx,
        readResults: buildReadResultsIndex(events, epochNum),
        ...(rules === undefined
          ? {}
          : {
              policy: {
                rules,
                mode,
                env: policyEnv as never,
                ...(parsers === undefined ? {} : { parsers }),
              },
            }),
      };
      const decideFn = (name: string, value: unknown): { behavior: "allow" | "ask" | "deny"; reason: string } => {
        if (input.args.disallowedTools.includes(name))
          return { behavior: "deny", reason: "disallowed by --disallowedTools" };
        if (input.args.allowedTools.includes(name)) return { behavior: "allow", reason: "allowed by --allowedTools" };
        if (rules === undefined) return { behavior: "allow", reason: "no rules" };
        const prep = registry.prepare(name, value);
        if (!prep.ok) return { behavior: "deny", reason: prep.message };
        try {
          const desc = prep.tool.describeAction(prep.input as never, ctx);
          if (desc.kind === "read" || desc.kind === "edit") {
            const d = decide(
              { tool: name, action: { kind: desc.kind, paths: [...desc.paths] } },
              { mode, rules, env: policyEnv },
            );
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
              { tool: name, action: { kind: "shell", analysis, sandboxed: desc.sandboxed } },
              { mode, rules, env: policyEnv },
            );
            return d.behavior === "allow"
              ? { behavior: "allow", reason: d.reason }
              : d.behavior === "deny"
                ? { behavior: "deny", reason: d.reason }
                : { behavior: "ask", reason: d.reason };
          }
          if (desc.kind === "network") {
            const d = decide(
              { tool: name, action: { kind: "network", host: desc.host } },
              { mode, rules, env: policyEnv },
            );
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
      const { results, stopped } = await executeTools(calls, {
        registry,
        decide: decideFn,
        prompt: () => Promise.resolve({ allow: false, dontAskAgain: false }),
        run: (tool, value, c) => (tool.run as (v: unknown, ctx: ToolContext) => Promise<never>)(value, c) as never,
        makeContext: () => ctx,
        offloadDir: `${input.dirs.data}/tmp`,
        headless: true,
        secrets: outputSecrets,
      });
      const byId = new Map(results.map((r) => [r.callId, r]));
      const recordCalls = (): void => {
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
        for (const r of results) {
          const text = r.output.content.map((x) => (x.kind === "text" ? x.text : "")).join("");
          const status = r.output.status === "ok" ? "ok" : r.output.status === "interrupted" ? "interrupted" : "error";
          push("tool.result", epochNum, turn, { callId: r.callId, status, output: text });
          for (const f of r.output.meta?.fileChanges ?? []) push("file.change", epochNum, turn, f);
        }
      };
      const guardExit = (message: string): HeadlessRunOutput => ({
        sessionId,
        result: message,
        stopReason: "error",
        incomplete: true,
        usage,
        cost: null,
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
          recordCalls();
          writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
          await writer.flush();
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
        recordCalls();
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "error" } });
        await writer.flush();
        return guardExit(progressPause.message);
      }
      recordCalls();
      if (stopped) {
        writer.append({ type: "turn.end", epoch: epochNum, turn, data: { reason: "end_turn" } });
        await writer.flush();
        const text = results
          .map((r) => r.output.content.map((x) => (x.kind === "text" ? x.text : "")).join(""))
          .join("\n");
        return {
          sessionId,
          result: text,
          stopReason: "end_turn",
          incomplete: false,
          usage,
          cost: null,
          receipt: {},
          exit: { kind: "ok" },
          warnings,
        };
      }
    }
  } finally {
    await writer.close();
  }
}
