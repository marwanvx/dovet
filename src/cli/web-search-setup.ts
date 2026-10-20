// Which WebSearch backend a session gets, from settings and connected search services (tools §10 "Choosing").

import type { Settings } from "../schema/index.ts";
import type { Credentials, ProviderAuth, Secret } from "../store/index.ts";
import { chooseSearchBackend, createWebSearchTool, type WebSearchTool } from "../tools/index.ts";

type KeyedService = "exa" | "brave" | "tavily";

/** The search services `/login` lists under "Search services"; each stores its key like a provider's. */
export const SEARCH_SERVICE_AUTH: Readonly<Record<KeyedService, ProviderAuth>> = {
  exa: { id: "exa", envVars: ["EXA_API_KEY"] },
  brave: { id: "brave", envVars: ["BRAVE_API_KEY"] },
  tavily: { id: "tavily", envVars: ["TAVILY_API_KEY"] },
};

export type WebSearchSetup = {
  tool?: WebSearchTool;
  /** Why the tool is absent, as `/status` words it. */
  unavailable?: string;
  /** Resolved keys, for the output redaction set. */
  keys: Secret[];
  warnings: string[];
};

export async function setupWebSearch(input: {
  settings: Readonly<Settings>;
  credentials: Pick<Credentials, "resolve">;
  /** The session's endpoint can search through a secondary request (a model completion is wired). */
  providerSearch: boolean;
  fetch?: typeof fetch;
}): Promise<WebSearchSetup> {
  const warnings: string[] = [];
  const keys: Partial<Record<KeyedService, Secret>> = {};
  for (const id of Object.keys(SEARCH_SERVICE_AUTH) as KeyedService[]) {
    try {
      const found = await input.credentials.resolve(id);
      if (found?.secret !== undefined) keys[id] = found.secret;
      warnings.push(...(found?.warnings ?? []));
    } catch (err) {
      warnings.push(`${id} search key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const setting = input.settings.websearch?.backend ?? "auto";
  const choice = chooseSearchBackend({
    setting,
    providerSearch: input.providerSearch,
    connected: (Object.keys(SEARCH_SERVICE_AUTH) as KeyedService[]).filter((id) => keys[id] !== undefined),
    searxngUrl: input.settings.websearch?.searxngUrl,
  });
  const secrets = Object.values(keys);
  if (!choice.ok) return { unavailable: choice.text, keys: secrets, warnings };
  const tool = createWebSearchTool({
    backend: choice.backend,
    auto: setting === "auto",
    ...(choice.fallback === undefined ? {} : { fallback: choice.fallback }),
    keys,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return { tool, keys: secrets, warnings };
}
