Runs a PowerShell 7 command on Windows and returns its output.

(Same rules as Bash.) This is PowerShell, not bash: use cmdlets and PowerShell syntax. Common equivalents: `ls` → `Get-ChildItem`, `cat` → `Get-Content`, `grep` → `Select-String`, `rm -r` → `Remove-Item -Recurse`, `export X=1` → `$env:X = "1"` (lasts only for this command). `&&` and `||` work. Paths use backslashes; quote paths with spaces. To write files, prefer the Write tool.
