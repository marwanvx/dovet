import { saveLocalRule } from "../../store/index.ts";
import type { Grant } from "./suggest.ts";

/** Permanent rules go to `<project root>/.dovet/settings.local.json`; session rules are returned for the agent to hold and are never written. */
export async function saveGrant(grant: Grant, projectRoot: string): Promise<string[]> {
  if (grant.scope === "permanent") for (const rule of grant.rules) await saveLocalRule(projectRoot, "allow", rule);
  return grant.rules;
}
