param(
    [string]$TeamKey
)

$ErrorActionPreference = "Stop"

function Write-Header([string]$Message) {
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Step([string]$Message) {
    Write-Host "-> $Message" -ForegroundColor Yellow
}

function Write-Success([string]$Message) {
    Write-Host "OK $Message" -ForegroundColor Green
}

function Get-NpmPrefix {
    return (& npm prefix -g).Trim()
}

function Resolve-KodusCommand {
    $command = Get-Command kodus -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $prefix = Get-NpmPrefix
    $candidate = Join-Path $prefix "kodus.cmd"
    if (Test-Path $candidate) {
        return $candidate
    }

    throw "Unable to find kodus after installation. Open a new terminal and try again."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is required but was not found. Install Node.js from https://nodejs.org and run again."
}

Write-Header "Kodus CLI installer (PowerShell)"
Write-Step "Installing or updating @kodus/cli"
& npm install -g @kodus/cli | Out-Host

$npmPrefix = Get-NpmPrefix
if (-not ($env:Path -split ';' | Where-Object { $_ -eq $npmPrefix })) {
    $env:Path = "$npmPrefix;$env:Path"
}

$kodus = Resolve-KodusCommand
$version = (& $kodus --version).Trim()
Write-Success "Kodus CLI ready ($version)"

if ($TeamKey) {
    Write-Step "Authenticating with team key"
    & $kodus auth team-key --key $TeamKey | Out-Host
    Write-Success "Authenticated successfully"
}

Write-Step "Installing bundled Kodus skills into detected agent roots"
& $kodus skills install | Out-Host
Write-Success "Bundled skills installed"
