param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [switch]$PrintUrlOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EnterpriseServerHttps.ps1')

$configurationPath = Join-Path ([IO.Path]::GetFullPath($DataRoot)) 'server-config.json'
if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
  throw '未找到企业服务器安装配置。请使用安装服务器的 Windows 账号运行。'
}
$configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
if (Get-EnterpriseHttpsEnabled -Configuration $configuration) {
  $https = Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl ([string]$configuration.external_https_url)
  if (-not $https.Enabled) { throw '服务器 HTTPS 配置无效；未打开浏览器。' }
  $origin = $https.Origin
} else {
  $port = 0
  if (-not [int]::TryParse([string]$configuration.http_port, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) {
    throw '服务器本地端口配置无效；未打开浏览器。'
  }
  $origin = "http://127.0.0.1:$port"
}
$consoleUrl = "$origin/enterprise/console/"
if ($PrintUrlOnly) { $consoleUrl; return }
if (-not (Get-EnterpriseHttpsEnabled -Configuration $configuration) -and
    (Test-Path -LiteralPath (Join-Path $DataRoot 'secrets\local-console.dpapi') -PathType Leaf)) {
  . (Join-Path $PSScriptRoot 'LocalServerConsoleRuntime.ps1')
  Invoke-LocalServerConsoleCommand -DataRoot $DataRoot -Action open
  return
}
Start-Process -FilePath $consoleUrl
