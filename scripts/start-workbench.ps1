param(
  [string]$Bind = "127.0.0.1",
  [int]$Port = 8000,
  [string]$Database = "tradeloom_dev"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = if ($env:TRADELOOM_PYTHON) {
  $env:TRADELOOM_PYTHON
} else {
  Join-Path $env:LOCALAPPDATA "TradeLoom\python-env\Scripts\python.exe"
}
$passwordFile = Join-Path $env:LOCALAPPDATA "PostgreSQL\tradeloom\superuser-password.txt"
if (-not (Test-Path -LiteralPath $python)) { throw "Python runtime missing: $python" }
if (-not (Test-Path -LiteralPath $passwordFile)) { throw "Local PG password file missing" }

$env:TRADELOOM_DB_NAME = $Database
$env:TRADELOOM_DB_USER = if ($env:TRADELOOM_DB_USER) { $env:TRADELOOM_DB_USER } else { "tradeloom" }
$env:TRADELOOM_DB_PASSWORD = Get-Content -LiteralPath $passwordFile -Raw
$env:TRADELOOM_DB_HOST = if ($env:TRADELOOM_DB_HOST) { $env:TRADELOOM_DB_HOST } else { "127.0.0.1" }
$env:TRADELOOM_DB_PORT = if ($env:TRADELOOM_DB_PORT) { $env:TRADELOOM_DB_PORT } else { "55432" }
$env:TRADELOOM_DB_TEST_NAME = if ($env:TRADELOOM_DB_TEST_NAME) { $env:TRADELOOM_DB_TEST_NAME } else { "tradeloom_test" }
$env:TRADELOOM_SECRET_KEY = if ($env:TRADELOOM_SECRET_KEY) { $env:TRADELOOM_SECRET_KEY } else { "local-development-only" }

Set-Location $projectRoot
& $python manage.py runserver "$Bind`:$Port"
