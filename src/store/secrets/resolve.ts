import { Secret } from "./secret.ts";
import type { SecretLocation, SecretStore } from "./store.ts";

/** A provider's auth data from its registry record. */
export type ProviderAuth = {
  id: string;
  /** Standard env vars holding an API key, in the order they are tried. */
  envVars: readonly string[];
  /** Env vars the provider rejects when more than one is set (Anthropic: API key and auth token, 401). */
  exclusiveEnvVars?: readonly string[];
};

export type CredentialSource =
  | { kind: "settings"; reference: "env" | "keychain"; name: string }
  | { kind: "settings"; reference: "cmd" | "none" }
  | { kind: "login"; location: SecretLocation }
  | { kind: "env"; name: string };

export type Resolved = { secret?: Secret; source: CredentialSource; warnings: string[] };
export type CredentialStatus = { sources: Array<{ source: CredentialSource; used: boolean }>; warnings: string[] };
export type CommandRunner = (
  command: string,
  signal: AbortSignal,
) => Promise<{ exitCode: number | null; stdout: string }>;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export type CredentialsDeps = {
  store: SecretStore;
  env: Readonly<Record<string, string | undefined>>;
  /** Runs a `cmd:` reference through the user's shell; the composition root decides which shell. */
  runCommand: CommandRunner;
  commandTimeoutMs?: number;
  /** `reference` is `providers.<id>.apiKey` from merged settings, which refuse `cmd:` outside user settings. */
  providers: Readonly<Record<string, { auth: ProviderAuth; reference?: string }>>;
};

export interface Credentials {
  /** The first match of the resolution order (cli-config "Secrets"); undefined when no source has a key. */
  resolve(provider: string): Promise<Resolved | undefined>;
  /** Every source that has a credential, without values and without running `cmd:` references. */
  status(provider: string): Promise<CredentialStatus>;
}

const COMMAND_TIMEOUT_MS = 10_000;

function parseReference(ref: string): { kind: "env" | "keychain" | "cmd"; arg: string } | { kind: "none" } {
  if (ref === "none") return { kind: "none" };
  const colon = ref.indexOf(":");
  const kind = ref.slice(0, colon);
  if (kind !== "env" && kind !== "keychain" && kind !== "cmd") throw new CredentialError("invalid apiKey reference");
  return { kind, arg: ref.slice(colon + 1) };
}

export function createCredentials(deps: CredentialsDeps): Credentials {
  const commandOutputs = new Map<string, Promise<Secret>>();
  const timeoutMs = deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const envValue = (name: string): string | undefined => (deps.env[name] === "" ? undefined : deps.env[name]);

  function providerOf(id: string) {
    return deps.providers[id] ?? { auth: { id, envVars: [] } };
  }

  function warnings(auth: ProviderAuth): string[] {
    const set = (auth.exclusiveEnvVars ?? []).filter((v) => envValue(v) !== undefined);
    if (set.length < 2) return [];
    const names = `${set.slice(0, -1).join(", ")} and ${set.at(-1)}`;
    return [`${names} are both set; ${auth.id} rejects requests that carry both (401). Unset one of them.`];
  }

  async function run(command: string): Promise<Secret> {
    const failed = (why: string) => new CredentialError(`the apiKey command \`${command}\` ${why}`);
    const signal = AbortSignal.timeout(timeoutMs);
    let result: Awaited<ReturnType<CommandRunner>>;
    try {
      result = await deps.runCommand(command, signal);
    } catch (err) {
      if (signal.aborted) throw failed(`did not finish within ${timeoutMs / 1000} s`);
      throw failed(`could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result.exitCode !== 0) throw failed(`exited with code ${result.exitCode ?? "(killed)"}`);
    const key = result.stdout.trim();
    if (key === "") throw failed("printed nothing");
    return new Secret(key);
  }

  function runOnce(command: string): Promise<Secret> {
    let pending = commandOutputs.get(command);
    if (pending === undefined) {
      pending = run(command);
      commandOutputs.set(command, pending);
      pending.catch(() => commandOutputs.delete(command));
    }
    return pending;
  }

  async function fromSettings(id: string, ref: string): Promise<{ secret?: Secret; source: CredentialSource }> {
    const parsed = parseReference(ref);
    const where = `providers.${id}.apiKey`;
    switch (parsed.kind) {
      case "none":
        return { source: { kind: "settings", reference: "none" } };
      case "cmd":
        return { secret: await runOnce(parsed.arg), source: { kind: "settings", reference: "cmd" } };
      case "env": {
        const value = envValue(parsed.arg);
        if (value === undefined)
          throw new CredentialError(`${where} is env:${parsed.arg}, but ${parsed.arg} is not set`);
        return { secret: new Secret(value), source: { kind: "settings", reference: "env", name: parsed.arg } };
      }
      case "keychain": {
        const found = await deps.store.get(parsed.arg);
        if (found === undefined)
          throw new CredentialError(`${where} names keychain entry "${parsed.arg}", which doesn't exist`);
        return { secret: found.secret, source: { kind: "settings", reference: "keychain", name: parsed.arg } };
      }
    }
  }

  return {
    async resolve(id) {
      const { auth, reference } = providerOf(id);
      const warned = warnings(auth);
      if (reference !== undefined) return { ...(await fromSettings(id, reference)), warnings: warned };
      const login = await deps.store.get(id);
      if (login !== undefined)
        return { secret: login.secret, source: { kind: "login", location: login.location }, warnings: warned };
      const name = auth.envVars.find((v) => envValue(v) !== undefined);
      const value = name === undefined ? undefined : envValue(name);
      if (name === undefined || value === undefined) return undefined;
      return { secret: new Secret(value), source: { kind: "env", name }, warnings: warned };
    },

    async status(id) {
      const { auth, reference } = providerOf(id);
      const found: CredentialSource[] = [];
      if (reference !== undefined) {
        const parsed = parseReference(reference);
        if (parsed.kind === "none" || parsed.kind === "cmd") found.push({ kind: "settings", reference: parsed.kind });
        else found.push({ kind: "settings", reference: parsed.kind, name: parsed.arg });
      }
      const login = await deps.store.get(id);
      if (login !== undefined) found.push({ kind: "login", location: login.location });
      for (const name of auth.envVars) if (envValue(name) !== undefined) found.push({ kind: "env", name });
      return { sources: found.map((source, i) => ({ source, used: i === 0 })), warnings: warnings(auth) };
    },
  };
}
