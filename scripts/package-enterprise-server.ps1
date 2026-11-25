param(
  [string]$ElectronDist,
  [string]$RuntimeSource,
  [string]$OutputRoot
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workbench = Join-Path $repo 'apps\tradeloom-enterprise-server'
if (-not $ElectronDist) { $ElectronDist = Join-Path $workbench 'node_modules\electron\dist' }
if (-not $RuntimeSource) { $RuntimeSource = Join-Path $repo 'enterprise-runtime-bundle' }
if (-not $OutputRoot) { $OutputRoot = Join-Path $repo 'dist\TradeLoom-Enterprise-Server' }
$electron = [IO.Path]::GetFullPath($ElectronDist)
$runtime = [IO.Path]::GetFullPath($RuntimeSource)
$output = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $output) { throw '输出目录已存在，请使用新的目录；现有文件未改动。' }
foreach ($source in @($repo, $electron, $runtime)) {
  if ($output -ieq $source -or $output.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and $source -ine $repo) {
    throw '输出目录不能位于运行库目录内。'
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $electron 'electron.exe') -PathType Leaf)) { throw '未找到本地 Windows Electron。' }
if ((Get-Content -LiteralPath (Join-Path $electron 'version') -Raw).Trim() -ne '45.4.1') { throw '版本要求 Electron 45.4.1。' }
foreach ($required in @('python\python.exe','python-packages\django\__init__.py','python-packages\psycopg\__init__.py','postgresql\bin\pg_ctl.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $runtime $required) -PathType Leaf)) { throw "服务器运行库不完整：$required" }
}

New-Item -ItemType Directory -Path $output | Out-Null
foreach ($entry in @('config','enterprise_portal','workbench','scripts','docs','manage.py','README-Windows-Enterprise-Server.txt',
    'Start-ServerGui.vbs','Install-EnterpriseServer.ps1','Start-EnterpriseServer.ps1','Stop-EnterpriseServer.ps1',
    'Update-EnterpriseServer.ps1','Start-Server.ps1','Manage-SshAccess.ps1')) {
  Copy-Item -LiteralPath (Join-Path $repo $entry) -Destination $output -Recurse
}
Copy-Item -LiteralPath $runtime -Destination (Join-Path $output 'enterprise-runtime-bundle') -Recurse

$shell = Join-Path $output 'server-workbench'
New-Item -ItemType Directory -Path $shell | Out-Null
Get-ChildItem -LiteralPath $electron -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $shell -Recurse }
Move-Item -LiteralPath (Join-Path $shell 'electron.exe') -Destination (Join-Path $shell 'TradeLoom Enterprise Server.exe')
$app = Join-Path $shell 'resources\app'
New-Item -ItemType Directory -Path $app | Out-Null
foreach ($file in @('package.json','entry.cjs','main.cjs','preload.cjs','backend.cjs','index.html','renderer.js','workbench.css')) {
  Copy-Item -LiteralPath (Join-Path $workbench $file) -Destination $app
}
Write-Output "Package: $output"
