<#
.SYNOPSIS
    Build the Cooking App Windows launcher, from Windows itself.

.DESCRIPTION
    Windows-native front end for scripts/make_windows_bundle.py -- the same
    bundler `make exe` runs from WSL. It exists because stock Windows has
    neither `make` nor a `python3` command, so the Makefile recipe cannot run
    there.

    Difference from the WSL path: nothing is translated. The desktop shortcut
    ends up pointing at server.py where this repo sits on the Windows drive,
    instead of at a \\wsl.localhost\... path.

    If no Python is installed, it downloads the official embeddable
    distribution into .build-cache and bundles with that -- so a bare Windows
    box needs no prerequisites (and no pip, ever). That same download is the
    runtime the bundler stages, so it is fetched once.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make_windows_bundle.ps1

.EXAMPLE
    .\scripts\make_windows_bundle.ps1 -Target D:\Apps\CookingApp -NoShortcut
#>
[CmdletBinding()]
param(
    [string] $Target = 'C:\Tools\CookingApp',
    [string] $PythonVersion = '3.12.10',
    [switch] $NoShortcut
)

$ErrorActionPreference = 'Stop'

$repo      = Split-Path -Parent $PSScriptRoot
$bundler   = Join-Path $PSScriptRoot 'make_windows_bundle.py'
$cacheDir  = Join-Path $repo '.build-cache'
$embedZip  = Join-Path $cacheDir "python-$PythonVersion-embed-amd64.zip"
$bootstrap = Join-Path $cacheDir 'python-bootstrap'

if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
    throw "This builds the Windows launcher on Windows. From Linux/WSL use: make exe"
}
if (-not (Test-Path $bundler)) { throw "bundler not found: $bundler" }

# --- Find a Python, or fetch one ---------------------------------------------
#
# The Microsoft Store's python.exe stub is on PATH by default on a machine with
# no Python: it prints an ad and exits non-zero, so probing by *running* it --
# rather than by Get-Command -- is what keeps us honest.

function Find-Python {
    foreach ($candidate in @(@('py', '-3'), @('python'), @('python3'))) {
        $exe, $pre = $candidate[0], @($candidate[1..($candidate.Count - 1)])
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        & $exe @pre -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>$null
        if ($LASTEXITCODE -eq 0) {
            return [pscustomobject]@{ Exe = $exe; Pre = $pre; Label = ($candidate -join ' ') }
        }
    }
    return $null
}

function Get-EmbeddablePython {
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    if (-not (Test-Path $embedZip) -or (Get-Item $embedZip).Length -lt 1MB) {
        $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
        Write-Host "  downloading $url"
        # Windows PowerShell 5.1 still negotiates TLS 1.0 by default; python.org says no.
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $embedZip -UseBasicParsing
    } else {
        Write-Host "  cached $(Split-Path -Leaf $embedZip)"
    }

    # Kept in .build-cache, deliberately not in $Target\python: the bundler wipes
    # that folder, and Windows will not let it delete the interpreter running it.
    if (Test-Path $bootstrap) { Remove-Item -Recurse -Force $bootstrap }
    Expand-Archive -Path $embedZip -DestinationPath $bootstrap -Force
    return [pscustomobject]@{
        Exe = (Join-Path $bootstrap 'python.exe'); Pre = @(); Label = 'embeddable python'
    }
}

Write-Host "repo:   $repo"
Write-Host "python:"
$py = Find-Python
if ($py) {
    Write-Host "  using installed '$($py.Label)'"
} else {
    Write-Host "  no Python found; using the embeddable distribution"
    $py = Get-EmbeddablePython
}

# --- Run the bundler ----------------------------------------------------------

$bundlerArgs = @($bundler, '--target', $Target, '--python-version', $PythonVersion)
if ($NoShortcut) { $bundlerArgs += '--no-shortcut' }

& $py.Exe @($py.Pre) @bundlerArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
