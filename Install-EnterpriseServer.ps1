param(
  [string]$RuntimeSource = '',
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [int]$Port = 27417,
  [string]$ExternalHttpsUrl = ''
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\Install-EnterpriseServer.ps1') `
  -RuntimeSource $RuntimeSource -DataRoot $DataRoot -Port $Port -ExternalHttpsUrl $ExternalHttpsUrl
