# Installs Dovet (cli-config "Install, PATH and uninstall"). Test hooks: DOVET_BASE_URL, DOVET_RELEASE_PUBLIC_KEYS, DOVET_INSTALL_DIR, DOVET_NONINTERACTIVE. One script block, so `iex` leaves nothing in the session.
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$EmbeddedKeys = ""
$LatestUrl = 'https://github.com/marwanvx/dovet/releases/latest/download'

# Windows PowerShell 5.1 has no Ed25519, so the signature is checked with BigInteger arithmetic (RFC 8032, section 5.1.7).
Add-Type -AssemblyName System.Numerics
$BI = [System.Numerics.BigInteger]
$Prime = $BI::Pow(2, 255) - 19
$Order = $BI::Pow(2, 252) + $BI::Parse('27742317777372353535851937790883648493')

function Mod-Prime($v) {
    $r = $BI::Remainder($v, $Prime)
    if ($r.Sign -lt 0) { $r + $Prime } else { $r }
}
function Inv-Prime($v) { $BI::ModPow((Mod-Prime $v), $Prime - 2, $Prime) }
function ConvertTo-Int([byte[]]$bytes) { $BI::new([byte[]]($bytes + [byte]0)) }

$CurveD = Mod-Prime ([bigint]-121665 * (Inv-Prime 121666))
$SqrtM1 = $BI::ModPow([bigint]2, ($Prime - 1) / 4, $Prime)

function Read-Point([byte[]]$enc) {
    $sign = $enc[31] -shr 7
    $copy = [byte[]]$enc.Clone()
    $copy[31] = $copy[31] -band 0x7F
    $y = ConvertTo-Int $copy
    if ($y -ge $Prime) { return $null }
    $yy = Mod-Prime ($y * $y)
    $xx = Mod-Prime (($yy - 1) * (Inv-Prime ($CurveD * $yy + 1)))
    $x = $BI::ModPow($xx, ($Prime + 3) / 8, $Prime)
    if (-not (Mod-Prime ($x * $x - $xx)).IsZero) { $x = Mod-Prime ($x * $SqrtM1) }
    if (-not (Mod-Prime ($x * $x - $xx)).IsZero) { return $null }
    if ($x.IsZero -and $sign -eq 1) { return $null }
    if ([int]($x % 2) -ne $sign) { $x = $Prime - $x }
    , @($x, $y, [bigint]1, (Mod-Prime ($x * $y)))
}

function Add-Point($pt, $qt) {
    $ra = Mod-Prime (($pt[1] - $pt[0]) * ($qt[1] - $qt[0]))
    $rb = Mod-Prime (($pt[1] + $pt[0]) * ($qt[1] + $qt[0]))
    $rc = Mod-Prime (2 * $pt[3] * $qt[3] * $CurveD)
    $rd = Mod-Prime (2 * $pt[2] * $qt[2])
    $e = $rb - $ra; $f = $rd - $rc; $g = $rd + $rc; $h = $rb + $ra
    , @((Mod-Prime ($e * $f)), (Mod-Prime ($g * $h)), (Mod-Prime ($f * $g)), (Mod-Prime ($e * $h)))
}

function Multiply-Point($scalar, $pt) {
    $acc = @([bigint]0, [bigint]1, [bigint]1, [bigint]0)
    while ($scalar.Sign -gt 0) {
        if (-not $scalar.IsEven) { $acc = Add-Point $acc $pt }
        $pt = Add-Point $pt $pt
        $scalar = $BI::Divide($scalar, [bigint]2)
    }
    , $acc
}

function Test-SamePoint($pt, $qt) {
    (Mod-Prime ($pt[0] * $qt[2] - $qt[0] * $pt[2])).IsZero -and (Mod-Prime ($pt[1] * $qt[2] - $qt[1] * $pt[2])).IsZero
}

$BasePoint = Read-Point ([byte[]](@(0x58) + @(0x66) * 31))

function Test-Ed25519Signature([byte[]]$publicKey, [byte[]]$message, [byte[]]$signature) {
    if ($publicKey.Length -ne 32 -or $signature.Length -ne 64) { return $false }
    $keyPoint = Read-Point $publicKey
    $rBytes = [byte[]]$signature[0..31]
    $rPoint = Read-Point $rBytes
    if ($null -eq $keyPoint -or $null -eq $rPoint) { return $false }
    $s = ConvertTo-Int ([byte[]]$signature[32..63])
    if ($s -ge $Order) { return $false }
    $sha = [System.Security.Cryptography.SHA512]::Create()
    try { $hash = $sha.ComputeHash([byte[]]($rBytes + $publicKey + $message)) } finally { $sha.Dispose() }
    $k = $BI::Remainder((ConvertTo-Int $hash), $Order)
    Test-SamePoint (Multiply-Point $s $BasePoint) (Add-Point $rPoint (Multiply-Point $k $keyPoint))
}

function Get-File($url, $path) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $path
    } catch {
        throw "dovet install: downloading $url failed: $($_.Exception.Message)"
    }
}

function Test-GitBash {
    (Get-Command git -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'))
}

function Offer-Git {
    if (Test-GitBash) { return }
    if ($env:DOVET_NONINTERACTIVE -or -not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return }
    $answer = Read-Host "Git for Windows isn't installed. Dovet works best with its Git Bash. Install it now with winget (Microsoft's package manager)? [Yes / No]"
    if ($answer -match '^\s*y') { winget install --id Git.Git -e --source winget }
}

function Add-UserPath($entry) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($null -eq $key) { throw 'dovet install: the user environment registry key is missing' }
    try {
        $current = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
        $parts = @($current -split ';' | Where-Object { $_ -ne '' })
        if ($parts -contains $entry) { return }
        Write-Host "Adding $entry to your user PATH (HKCU\Environment\Path). The system PATH is not changed."
        $key.SetValue('Path', (($parts + $entry) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
        $key.Close()
    }
    # Writing the registry doesn't tell running programs; clearing a variable that doesn't exist broadcasts the change.
    [Environment]::SetEnvironmentVariable('DOVET_PATH_REFRESH', $null, 'User')
}

function Install-Dovet {
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $target = switch ($arch) {
        'AMD64' { 'windows-x64' }
        'ARM64' { 'windows-arm64' }
        default { throw "dovet install: no Dovet release for $arch" }
    }
    $base = if ($env:DOVET_BASE_URL) { $env:DOVET_BASE_URL } else { $LatestUrl }
    $root = [IO.Path]::GetFullPath($(if ($env:DOVET_INSTALL_DIR) { $env:DOVET_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'dovet' }))
    $keys = if ($env:DOVET_RELEASE_PUBLIC_KEYS) { $env:DOVET_RELEASE_PUBLIC_KEYS } else { $EmbeddedKeys }
    if (-not $keys) { throw "dovet install: this install script has no release key yet, so it can't verify a download" }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("dovet-install-" + [guid]::NewGuid())
    $scratch = $null
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Get-File "$base/SHA256SUMS" "$tmp\SHA256SUMS"
        Get-File "$base/SHA256SUMS.sig" "$tmp\SHA256SUMS.sig"
        $sums = [IO.File]::ReadAllBytes("$tmp\SHA256SUMS")
        $sig = [IO.File]::ReadAllBytes("$tmp\SHA256SUMS.sig")
        $trusted = $false
        foreach ($key in ($keys -split ',')) {
            if (Test-Ed25519Signature ([Convert]::FromBase64String($key.Trim())) $sums $sig) { $trusted = $true; break }
        }
        if (-not $trusted) { throw 'dovet install: the SHA256SUMS signature does not verify against any trusted release key' }

        $pattern = "^([0-9a-f]{64})  (dovet-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-$target\.tar\.gz)$"
        $found = @([Text.Encoding]::UTF8.GetString($sums) -split "`n" | Where-Object { $_ -match $pattern } | ForEach-Object {
            $m = [regex]::Match($_, $pattern)
            [pscustomobject]@{ Sha = $m.Groups[1].Value; Name = $m.Groups[2].Value; Version = $m.Groups[3].Value }
        })
        if ($found.Count -eq 0) { throw "dovet install: the latest release has no archive for $target" }
        if ($found.Count -gt 1) { throw "dovet install: the signed SHA256SUMS names more than one archive for $target" }
        $release = $found[0]

        $archive = Join-Path $tmp $release.Name
        Get-File "$base/$($release.Name)" $archive
        $actual = ([BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($archive))) -replace '-', '').ToLower()
        if ($actual -ne $release.Sha) {
            throw "dovet install: the checksum of $($release.Name) does not match the signed SHA256SUMS"
        }

        # System32's bsdtar: a GNU tar earlier on PATH (Git for Windows) reads "C:" as a host name.
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        $entries = @(& $tar -tzf $archive)
        if ($LASTEXITCODE -ne 0) { throw 'dovet install: the archive could not be read' }
        foreach ($e in $entries) {
            if ($e -notmatch '^dovet(/|$)' -or $e -match '(^|/)\.\.(/|$)' -or $e -match '[\\:]') { throw "dovet install: the archive holds a file outside dovet/: $e" }
        }
        if (@(& $tar -tvzf $archive | Where-Object { $_ -match '^[lh]' }).Count -gt 0) { throw 'dovet install: the archive holds a link' }

        $current = Join-Path $root 'current'
        $old = Join-Path $root 'current.old'
        # An interrupted swap leaves only current.old; put it back first, as `dovet update` does.
        if (-not (Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue) -and (Get-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue)) {
            [IO.Directory]::Move($old, $current)
        }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and -not $item.LinkType) { throw "dovet install: $current exists and is not a junction" }

        $versions = Join-Path $root 'versions'
        New-Item -ItemType Directory -Path $versions -Force | Out-Null
        $scratch = Join-Path $versions (".new-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $scratch | Out-Null
        & $tar -xzf $archive -C $scratch
        if ($LASTEXITCODE -ne 0) { throw 'dovet install: unpacking the archive failed' }
        if (-not (Test-Path (Join-Path $scratch 'dovet\dovet.exe'))) { throw 'dovet install: the archive has no dovet\dovet.exe' }

        $dest = Join-Path $versions $release.Version
        if (Test-Path -LiteralPath $dest) { Move-Item -LiteralPath $dest -Destination (Join-Path $scratch 'replaced') }
        try {
            Move-Item -LiteralPath (Join-Path $scratch 'dovet') -Destination $dest
        } catch {
            if (Test-Path -LiteralPath (Join-Path $scratch 'replaced')) { Move-Item -LiteralPath (Join-Path $scratch 'replaced') -Destination $dest }
            throw
        }

        # A directory junction needs no admin rights. It can't be renamed over, so the old one is set aside and put back on failure.
        if (Get-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue) { [IO.Directory]::Delete($old) }
        $left = $null
        if ($item) {
            $left = Split-Path -Leaf ($item.Target | Select-Object -First 1)
            [IO.Directory]::Move($current, $old)
        }
        try {
            New-Item -ItemType Junction -Path $current -Target $dest | Out-Null
        } catch {
            if ($left) { [IO.Directory]::Move($old, $current) }
            throw
        }
        if (Get-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue) { [IO.Directory]::Delete($old) }
        if ($left -and $left -ne $release.Version) {
            Set-Content -Path (Join-Path $root 'previous.new') -Value $left -Encoding ascii
            Move-Item -LiteralPath (Join-Path $root 'previous.new') -Destination (Join-Path $root 'previous') -Force
        }

        Write-Host "Installed dovet $($release.Version) in $root"
        Add-UserPath $current
        Offer-Git
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        if ($scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Install-Dovet
}
