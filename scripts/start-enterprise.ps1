param(
  [switch]$CreateAdmin,
  [string]$Python = "python",
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 27417
)
$ErrorActionPreference = 'Stop'
$loopback = @('127.0.0.1', 'localhost', '::1')
if ($BindHost -notin $loopback) { throw '此脚本仅允许绑定 loopback；远端请按部署文档使用 HTTPS 反向代理和 WSGI 服务。' }
foreach ($name in @('TRADELOOM_ENTERPRISE_SECRET_KEY', 'TRADELOOM_DB_NAME', 'TRADELOOM_DB_USER', 'TRADELOOM_DB_PASSWORD')) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) { throw "缺少环境变量 $name；脚本不会生成或保存生产凭据。" }
}
$env:DJANGO_SETTINGS_MODULE = 'config.enterprise_settings'
$env:TRADELOOM_ENTERPRISE_ALLOWED_HOSTS = "127.0.0.1,localhost,::1"
$env:TRADELOOM_ENTERPRISE_BIND_HOST = $BindHost
$env:TRADELOOM_ENTERPRISE_HTTPS = '0'
$env:TRADELOOM_ENTERPRISE_CSRF_TRUSTED_ORIGINS = ''
$env:PYTHONDONTWRITEBYTECODE = '1'
Push-Location (Join-Path $PSScriptRoot '..')
try {
  & $Python -B manage.py check
  if ($LASTEXITCODE -ne 0) { throw "Django check failed: $LASTEXITCODE" }
  & $Python -B manage.py migrate --noinput
  if ($LASTEXITCODE -ne 0) { throw "Django migration failed: $LASTEXITCODE" }
  & $Python -B manage.py configure_enterprise_groups
  if ($LASTEXITCODE -ne 0) { throw "Enterprise group setup failed: $LASTEXITCODE" }
  if ($CreateAdmin) {
    & $Python -B manage.py createsuperuser
    if ($LASTEXITCODE -ne 0) { throw "Superuser creation failed: $LASTEXITCODE" }
  }
  Write-Host "企业服务入口: http://${BindHost}:${Port}/enterprise/"
  & $Python -B manage.py runserver "${BindHost}:${Port}" --noreload --insecure
  if ($LASTEXITCODE -ne 0) { throw "Enterprise server exited: $LASTEXITCODE" }
} finally { Pop-Location }
