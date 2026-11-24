param([string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EnterpriseServerHttps.ps1')
. (Join-Path $PSScriptRoot 'LocalServerConsoleRuntime.ps1')
Invoke-LocalServerConsoleCommand -DataRoot $DataRoot -Action enable
