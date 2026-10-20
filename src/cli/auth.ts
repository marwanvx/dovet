import { join } from "node:path";
import { PROVIDER_AUTH } from "../ai/index.ts";
import { type Os, resolveDirs } from "../platform/index.ts";
import {
  type CredentialSource,
  createCredentials,
  createSecretStore,
  loadSettings,
  UNTRUSTED,
} from "../store/index.ts";

type Env = Readonly<Record<string, string | undefined>>;

function describeSource(source: CredentialSource, file: string): string {
  switch (source.kind) {
    case "settings":
      if ("name" in source) return `${source.reference}:${source.name} (settings)`;
      return source.reference === "cmd" ? "cmd: command (user settings)" : "none (settings)";
    case "login":
      return source.location === "keychain" ? "keychain (dovet auth login)" : `${file} (dovet auth login)`;
    case "env":
      return `environment variable ${source.name}`;
  }
}

/** `dovet auth status`: where each provider's credential comes from, never the credential itself. */
export async function authStatus(input: { os: Os; home: string; cwd: string; env: Env }): Promise<string> {
  const dirs = resolveDirs(input);
  const { settings } = await loadSettings({
    dirs,
    home: input.home,
    projectRoot: input.cwd,
    env: input.env,
    trust: UNTRUSTED,
  });
  const file = join(dirs.data, "credentials.json");
  const configured = settings.providers ?? {};
  const ids = [...new Set([...Object.keys(PROVIDER_AUTH), ...Object.keys(configured)])];
  const credentials = createCredentials({
    store: createSecretStore({ os: input.os, file }),
    env: input.env,
    runCommand: () => Promise.reject(new Error("auth status never runs commands")),
    providers: Object.fromEntries(
      ids.map((id) => {
        const reference = configured[id]?.apiKey;
        const auth = PROVIDER_AUTH[id] ?? { id, envVars: [] };
        return [id, reference === undefined ? { auth } : { auth, reference }];
      }),
    ),
  });

  const lines: string[] = [];
  for (const id of ids) {
    const { sources, warnings } = await credentials.status(id);
    lines.push(id);
    if (sources.length === 0) {
      const envVars = PROVIDER_AUTH[id]?.envVars ?? [];
      const hint = envVars.length > 0 ? `, or set ${envVars.join(" or ")}` : "";
      lines.push(`  not connected: run \`dovet auth login ${id}\`${hint}`);
    }
    for (const { source, used, missing } of sources) {
      let broken = "";
      if (missing && source.kind === "settings" && "name" in source) {
        broken =
          source.reference === "env" ? `, but ${source.name} is not set` : ", but that keychain entry doesn't exist";
      }
      lines.push(`  ${used ? "used" : "shadowed"}: ${describeSource(source, file)}${broken}`);
    }
    for (const w of warnings) lines.push(`  warning: ${w}`);
  }
  return `${lines.join("\n")}\n`;
}
