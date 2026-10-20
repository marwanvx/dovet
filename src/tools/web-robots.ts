// WebFetch robots.txt (tools §9): only rules addressed to Dovet-User apply.

type Rule = { allow: boolean; pattern: RegExp; length: number };

function ruleFor(path: string, allow: boolean): Rule {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return { allow, pattern: new RegExp(`^${body}${anchored ? "$" : ""}`), length: path.length };
}

/** Rules from the group addressed to `agent` only; a generic `*` group is not applied (tools §9). */
export function robotsRules(text: string, agent: string): Rule[] {
  const rules: Rule[] = [];
  let ours = false;
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!inAgents) ours = false;
      inAgents = true;
      if (value.toLowerCase() === agent.toLowerCase()) ours = true;
      continue;
    }
    inAgents = false;
    if (!ours || (key !== "disallow" && key !== "allow") || value === "") continue;
    rules.push(ruleFor(value, key === "allow"));
  }
  return rules;
}

/** The longest matching rule wins; on a tie, Allow does (RFC 9309). */
export function robotsAllows(rules: readonly Rule[], pathAndQuery: string): boolean {
  let best: Rule | undefined;
  for (const r of rules) {
    if (!r.pattern.test(pathAndQuery)) continue;
    if (best === undefined || r.length > best.length || (r.length === best.length && r.allow)) best = r;
  }
  return best === undefined || best.allow;
}
