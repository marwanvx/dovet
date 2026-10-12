Runs a Windows PowerShell 5.1 command and returns its output.

(Same rules as Bash.) This is Windows PowerShell 5.1, not bash and not PowerShell 7:
- `&&` and `||` don't exist. Use `cmd1; if ($?) { cmd2 }`.
- `curl` and `wget` are aliases of `Invoke-WebRequest`. Call `curl.exe` for real curl.
- `>` writes UTF-16 files. Use the Write tool, or `Set-Content -Encoding utf8`.
- Double quotes inside arguments passed to native programs are stripped. Use single quotes, or `--%` to stop PowerShell's parsing.
- Common equivalents: `ls` → `Get-ChildItem`, `cat` → `Get-Content`, `grep` → `Select-String`, `rm -r` → `Remove-Item -Recurse`, `export X=1` → `$env:X = "1"` (lasts only for this command). Paths use backslashes; quote paths with spaces.
