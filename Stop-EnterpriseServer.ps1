param([string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'))
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\Stop-EnterpriseServer.ps1') -DataRoot $DataRoot
