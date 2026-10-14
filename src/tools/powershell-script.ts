// What PowerShell runs for one command (tools §6): the wrapper around the user's command, and how it is passed.
export type Edition = "pwsh" | "windows";

const q = (s: string): string => `'${s.replace(/['‘’‚‛]/g, (c) => c + c)}'`;

const POLICY_ERROR =
  /running scripts is disabled on this system|is not digitally signed|cannot be loaded because|PSSecurityException/i;

/** True when the output shows Group Policy refusing `-File` (the first call; later calls use `-Command`). */
export const isPolicyRefusal = (output: string): boolean => POLICY_ERROR.test(output);

/**
 * The script text. The first line of `cwdFile` is the final directory, the second the language mode. The exit code is
 * the last native program's when the last pipeline was one (its `$LASTEXITCODE` agrees with `$?`, or is 0 while 5.1 turned stderr under `2>&1` into error records), else 1 if `$?` is false.
 */
export function powershellScript(opts: { command: string; cwd: string; cwdFile: string; edition: Edition }): string {
  const edition =
    opts.edition === "pwsh"
      ? "try { $PSStyle.OutputRendering = 'PlainText' } catch {}"
      : "try { $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8' } catch {}";
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Continue'",
    "try { $__utf8 = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $__utf8; [Console]::InputEncoding = $__utf8; $OutputEncoding = $__utf8 } catch {}",
    edition,
    `Set-Location -LiteralPath ${q(opts.cwd)}`,
    "$global:LASTEXITCODE = $null",
    "try {",
    opts.command,
    "$__ok = $?; $__native = $LASTEXITCODE; $__nce = ($Error.Count -gt 0) -and ([string]$Error[0].FullyQualifiedErrorId -like 'NativeCommandError*')",
    "} finally {",
    `try { Set-Content -LiteralPath ${q(opts.cwdFile)} -Value ((Get-Location).ProviderPath + "\`n" + $ExecutionContext.SessionState.LanguageMode) -Encoding UTF8 } catch {}`,
    "}",
    "if ($null -ne $__native -and ((($__native -eq 0) -eq $__ok) -or ($__native -eq 0 -and $__nce))) { exit $__native }",
    "if ($__ok) { exit 0 } else { exit 1 }",
    "",
  ].join("\n");
}

const FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

/** Never `-EncodedCommand`: EDR products block it as malware tradecraft. */
export function powershellArgv(opts: {
  exe: string;
  scriptPath: string;
  scriptText: string;
  viaCommand: boolean;
}): string[] {
  return opts.viaCommand
    ? [opts.exe, ...FLAGS, "-Command", opts.scriptText]
    : [opts.exe, ...FLAGS, "-ExecutionPolicy", "Bypass", "-File", opts.scriptPath];
}
