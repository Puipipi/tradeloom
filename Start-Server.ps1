param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [string]$RuntimeSource = '',
  [int]$Port = 27417
)
$ErrorActionPreference = 'Stop'
try {
  $config = Join-Path ([IO.Path]::GetFullPath($DataRoot)) 'server-config.json'
  if (Test-Path -LiteralPath $config -PathType Leaf) {
    & (Join-Path $PSScriptRoot 'Start-EnterpriseServer.ps1') -DataRoot $DataRoot
  } else {
    Write-Host '首次启动：将安装独立台账服务，请自行设置管理员用户名和密码。'
    & (Join-Path $PSScriptRoot 'Install-EnterpriseServer.ps1') -DataRoot $DataRoot -RuntimeSource $RuntimeSource -Port $Port
  }
  # Resume administrator setup after an interrupted first installation.
  $installed = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
  $python = Join-Path $installed.runtime_root 'python\python.exe'
  $checkAdmin = 'import django,sys; django.setup(); from django.contrib.auth import get_user_model; sys.exit(0 if get_user_model().objects.filter(is_superuser=True,is_active=True).exists() else 2)'
  Push-Location $installed.app_root
  try {
    & $python -B -c $checkAdmin
    if ($LASTEXITCODE -eq 2) {
      Write-Host '请创建首个管理员账号；用户名和密码由您自行填写。'
      & $python -B manage.py createsuperuser
      if ($LASTEXITCODE -ne 0) { throw 'Administrator creation failed.' }
      & $python -B -c $checkAdmin
    }
    if ($LASTEXITCODE -ne 0) { throw 'No active administrator is configured. Run this entry from an interactive terminal to finish account setup.' }
  } finally { Pop-Location }
  Write-Host '台账服务已启动。停止服务请运行同目录 Stop-EnterpriseServer.ps1。'
} catch {
  Write-Host ('台账服务未能启动：' + $_.Exception.Message)
  throw
}
