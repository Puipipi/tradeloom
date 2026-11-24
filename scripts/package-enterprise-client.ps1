param([string]$ElectronDist, [string]$OutputRoot, [ValidateSet('generic','owner','factory')][string]$Edition = 'generic')
$ErrorActionPreference = 'Stop'
$Edition = $Edition.ToLowerInvariant()
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$clientRoot = Join-Path $repoRoot 'apps\tradeloom-enterprise-client'
$electronRoot = if ([string]::IsNullOrWhiteSpace($ElectronDist)) { Join-Path $clientRoot 'node_modules\electron\dist' } else { [IO.Path]::GetFullPath($ElectronDist) }
$outputRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) { Join-Path $repoRoot 'dist\TradeLoom-Enterprise-Client' } else { [IO.Path]::GetFullPath($OutputRoot) }
$appRoot = Join-Path $outputRoot 'resources\app'
if (-not (Test-Path -LiteralPath (Join-Path $electronRoot 'electron.exe') -PathType Leaf)) { throw '未找到 Electron 45.4.1 runtime。请先在客户端运行 npm install。' }
$version = (Get-Content -LiteralPath (Join-Path $electronRoot 'version') -Raw).Trim()
if ($version -ne '45.4.1') { throw "Electron 版本不匹配：$version" }
if (Test-Path -LiteralPath $outputRoot) { Remove-Item -LiteralPath $outputRoot -Recurse -Force }
New-Item -ItemType Directory -Path $outputRoot,$appRoot | Out-Null
Copy-Item -Path (Join-Path $electronRoot '*') -Destination $outputRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $clientRoot 'package.json') -Destination (Join-Path $appRoot 'package.json')
foreach ($file in @('main.cjs','preload.cjs','renderer.js','index.html','security.cjs','login.cjs')) { Copy-Item -LiteralPath (Join-Path $clientRoot $file) -Destination (Join-Path $appRoot $file) }
if ($Edition -ne 'generic') { [IO.File]::WriteAllText((Join-Path $appRoot 'edition.json'), ('{"edition":"' + $Edition + '"}'), (New-Object Text.UTF8Encoding($false))) }
Move-Item -LiteralPath (Join-Path $outputRoot 'electron.exe') -Destination (Join-Path $outputRoot 'TradeLoom 企业服务器客户端.exe')
Set-Content -LiteralPath (Join-Path $outputRoot '使用说明.txt') -Encoding utf8 -Value "双击 TradeLoom 企业服务器客户端.exe，输入域名或公网 IP、织贸内部账号和密码，通过后在同页填写绑定邮箱验证码。需配套支持邮箱验证的新版服务器；旧 rc15 密码登录服务不兼容。邮箱和 SMTP 由服务器管理员配置。客户端只保存服务器地址，不保存密码或验证码。此程序不会启动本机 PostgreSQL、Django 或 DSH。"
Write-Output "Package: $outputRoot"
Write-Output "Electron: v$version"
