$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$clientRoot = Join-Path $repoRoot 'apps\tradeloom-enterprise-client'
$electron = Join-Path $clientRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
  throw '企业客户端 Electron 尚未安装。请在 apps/tradeloom-enterprise-client 目录运行 npm install。此入口不启动本机服务。'
}
Start-Process -FilePath $electron -ArgumentList @($clientRoot) -WorkingDirectory $clientRoot
