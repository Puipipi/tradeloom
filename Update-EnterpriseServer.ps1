param([string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'))
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\Update-EnterpriseServer.ps1') -DataRoot $DataRoot
