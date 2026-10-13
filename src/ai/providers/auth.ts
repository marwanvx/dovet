import type { ProviderAuth } from "../../store/index.ts";

// ASSUMPTION (QUESTIONS Q21): the auth part of the registry records, here until the registry is built (M4).
export const PROVIDER_AUTH: Readonly<Record<string, ProviderAuth>> = {
  anthropic: {
    id: "anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    exclusiveEnvVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  },
  // The free test provider (testing "Free test provider: NVIDIA").
  nvidia: { id: "nvidia", envVars: ["NVIDIA_API_KEY"] },
};
