// WebFetch robots.txt (tools §9): only rules addressed to Dovet-User apply.

export type Rule = { allow: boolean; pattern: string; length: number };

const MAX_ALLOWS = 500;
const MAX_DISALLOWS = 2000;
const MAX_RULE_LENGTH = 512;

/** Linear-time wildcard match (`*` any run, trailing `$` anchors): a rule from a server is untrusted input. */
function matches(pattern: string, text: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0] ?? "";
  if (!text.startsWith(first)) return false;
  let at = first.length;
  if (parts.length === 1) return anchored ? text.length === first.length : true;
  const last = parts[parts.length - 1] ?? "";
  for (const part of parts.slice(1, -1)) {
    if (part === "") continue;
    const found = text.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  if (!anchored) {
    return last === "" || text.indexOf(last, at) >= 0;
  }
  return text.length - last.length >= at && text.endsWith(last);
}

/** Rules from the group addressed to `agent` only; a generic `*` group is not applied (tools §9). */
export function robotsRules(text: string, agent: string): Rule[] {
  const rules: Rule[] = [];
  let allows = 0;
  let disallows = 0;
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
    // Limits may only make the result stricter: a long or surplus Allow is dropped, a long Disallow is cut.
    const allow = key === "allow";
    if (!allow && disallows >= MAX_DISALLOWS) {
      if (disallows === MAX_DISALLOWS) rules.push({ allow: false, pattern: "/", length: Number.MAX_SAFE_INTEGER });
      disallows++;
      continue;
    }
    if (allow && (value.length > MAX_RULE_LENGTH || allows >= MAX_ALLOWS)) continue;
    if (allow) allows++;
    else disallows++;
    // A cut that lands after a mid-pattern `$` would turn it into an end anchor and narrow the rule.
    const cut = value.slice(0, MAX_RULE_LENGTH);
    const pattern = cut.length < value.length && cut.endsWith("$") ? cut.slice(0, -1) : cut;
    rules.push({ allow, pattern, length: value.length });
  }
  return rules;
}

/** The longest matching rule wins; on a tie, Allow does (RFC 9309). */
export function robotsAllows(rules: readonly Rule[], pathAndQuery: string): boolean {
  let best: Rule | undefined;
  for (const r of rules) {
    if (!matches(r.pattern, pathAndQuery)) continue;
    if (best === undefined || r.length > best.length || (r.length === best.length && r.allow)) best = r;
  }
  return best === undefined || best.allow;
}
