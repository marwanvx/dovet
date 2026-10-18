// The prompt files embedded in the binary; their hash is the prompt version in `epoch.start` (prompts/README.md).
import p_compact from "../../../docs/prompts/compact.md" with { type: "text" };
import p_conditional_git_attribution_trailer from "../../../docs/prompts/conditional/git-attribution-trailer.md" with {
  type: "text",
};
import p_conditional_websearch from "../../../docs/prompts/conditional/websearch.md" with { type: "text" };
import p_init from "../../../docs/prompts/init.md" with { type: "text" };
import p_instructions from "../../../docs/prompts/instructions.md" with { type: "text" };
import p_modes_acceptEdits from "../../../docs/prompts/modes/acceptEdits.md" with { type: "text" };
import p_modes_bypassPermissions from "../../../docs/prompts/modes/bypassPermissions.md" with { type: "text" };
import p_modes_default from "../../../docs/prompts/modes/default.md" with { type: "text" };
import p_modes_dontAsk from "../../../docs/prompts/modes/dontAsk.md" with { type: "text" };
import p_modes_headless from "../../../docs/prompts/modes/headless.md" with { type: "text" };
import p_modes_plan from "../../../docs/prompts/modes/plan.md" with { type: "text" };
import p_modes_sandbox_off from "../../../docs/prompts/modes/sandbox-off.md" with { type: "text" };
import p_modes_sandbox_on from "../../../docs/prompts/modes/sandbox-on.md" with { type: "text" };
import p_system from "../../../docs/prompts/system.md" with { type: "text" };
import p_tools_AskUserQuestion from "../../../docs/prompts/tools/AskUserQuestion.md" with { type: "text" };
import p_tools_Bash from "../../../docs/prompts/tools/Bash.md" with { type: "text" };
import p_tools_BashGitBash from "../../../docs/prompts/tools/BashGitBash.md" with { type: "text" };
import p_tools_Edit from "../../../docs/prompts/tools/Edit.md" with { type: "text" };
import p_tools_EnterPlanMode from "../../../docs/prompts/tools/EnterPlanMode.md" with { type: "text" };
import p_tools_ExitPlanMode from "../../../docs/prompts/tools/ExitPlanMode.md" with { type: "text" };
import p_tools_Glob from "../../../docs/prompts/tools/Glob.md" with { type: "text" };
import p_tools_Grep from "../../../docs/prompts/tools/Grep.md" with { type: "text" };
import p_tools_PowerShell from "../../../docs/prompts/tools/PowerShell.md" with { type: "text" };
import p_tools_PowerShell51 from "../../../docs/prompts/tools/PowerShell51.md" with { type: "text" };
import p_tools_Read from "../../../docs/prompts/tools/Read.md" with { type: "text" };
import p_tools_TodoWrite from "../../../docs/prompts/tools/TodoWrite.md" with { type: "text" };
import p_tools_WebFetch from "../../../docs/prompts/tools/WebFetch.md" with { type: "text" };
import p_tools_WebSearch from "../../../docs/prompts/tools/WebSearch.md" with { type: "text" };
import p_tools_Write from "../../../docs/prompts/tools/Write.md" with { type: "text" };

export const PROMPT_FILES: Readonly<Record<string, string>> = Object.freeze({
  "system.md": p_system,
  "instructions.md": p_instructions,
  "init.md": p_init,
  "compact.md": p_compact,
  "modes/acceptEdits.md": p_modes_acceptEdits,
  "modes/bypassPermissions.md": p_modes_bypassPermissions,
  "modes/default.md": p_modes_default,
  "modes/dontAsk.md": p_modes_dontAsk,
  "modes/headless.md": p_modes_headless,
  "modes/plan.md": p_modes_plan,
  "modes/sandbox-off.md": p_modes_sandbox_off,
  "modes/sandbox-on.md": p_modes_sandbox_on,
  "conditional/git-attribution-trailer.md": p_conditional_git_attribution_trailer,
  "conditional/websearch.md": p_conditional_websearch,
  "tools/AskUserQuestion.md": p_tools_AskUserQuestion,
  "tools/Bash.md": p_tools_Bash,
  "tools/BashGitBash.md": p_tools_BashGitBash,
  "tools/Edit.md": p_tools_Edit,
  "tools/EnterPlanMode.md": p_tools_EnterPlanMode,
  "tools/ExitPlanMode.md": p_tools_ExitPlanMode,
  "tools/Glob.md": p_tools_Glob,
  "tools/Grep.md": p_tools_Grep,
  "tools/PowerShell.md": p_tools_PowerShell,
  "tools/PowerShell51.md": p_tools_PowerShell51,
  "tools/Read.md": p_tools_Read,
  "tools/TodoWrite.md": p_tools_TodoWrite,
  "tools/WebFetch.md": p_tools_WebFetch,
  "tools/WebSearch.md": p_tools_WebSearch,
  "tools/Write.md": p_tools_Write,
});

export const PROMPT_VERSION: string = (() => {
  const hash = new Bun.CryptoHasher("sha256");
  for (const name of Object.keys(PROMPT_FILES).sort()) hash.update(`${name}\0${PROMPT_FILES[name]}\0`);
  return hash.digest("hex");
})();

/** A prompt file's text without its final newline. */
export function prompt(name: string): string {
  const text = PROMPT_FILES[name];
  if (text === undefined) throw new Error(`no prompt file ${name}`);
  return text.replace(/\r?\n$/, "");
}
