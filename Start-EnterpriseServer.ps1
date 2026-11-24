param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [switch]$EnableHttps,
  [switch]$DisableHttps,
  [string]$ExternalHttpsUrl = ''
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\Start-EnterpriseServer.ps1') `
  -DataRoot $DataRoot -EnableHttps:$EnableHttps -DisableHttps:$DisableHttps -ExternalHttpsUrl $ExternalHttpsUrl
