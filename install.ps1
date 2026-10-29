#!/usr/bin/env pwsh
# Install the hypotenuse CLI on Windows:
#   irm https://raw.githubusercontent.com/arcadeai-labs/hypotenuse/main/install.ps1 | iex
#
# $env:HYPOTENUSE_INSTALL_DIR  where to put it (default %LOCALAPPDATA%\hypotenuse)
# $env:HYPOTENUSE_VERSION      a release to pin, e.g. 2.0.0 (default: the latest)
#
# Re-running this is also how a Windows binary upgrades: Windows cannot replace
# a running .exe, so `hypotenuse upgrade` prints this line instead.

$ErrorActionPreference = 'Stop'

$Repo = "arcadeai-labs/hypotenuse"
$InstallDir = if ($env:HYPOTENUSE_INSTALL_DIR) { $env:HYPOTENUSE_INSTALL_DIR } else { "$env:LOCALAPPDATA\hypotenuse" }

$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default {
        Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
        exit 1
    }
}

if ($env:HYPOTENUSE_VERSION) {
    $Tag = "v" + $env:HYPOTENUSE_VERSION.TrimStart("v")
}
else {
    Write-Host "Fetching the latest release..."
    try {
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "hypotenuse-installer" }
        $Tag = $Release.tag_name
    }
    catch {
        Write-Error "Could not determine the latest release: $_"
        exit 1
    }
}
if (-not $Tag) {
    Write-Error "Could not determine the latest release tag"
    exit 1
}

$Asset = "hypotenuse-windows-$Arch.exe"
$Url = "https://github.com/$Repo/releases/download/$Tag/$Asset"

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
$OutFile = Join-Path $InstallDir "hypotenuse.exe"

Write-Host "Downloading hypotenuse $Tag (windows/$Arch)..."
try {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}
catch {
    Write-Error "Download failed: $_"
    exit 1
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    Write-Host "Adding $InstallDir to your user PATH..."
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Restart your terminal for the PATH change to take effect."
}

Write-Host "Installed $OutFile"
& $OutFile --version
