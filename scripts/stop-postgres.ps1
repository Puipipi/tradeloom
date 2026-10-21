$ErrorActionPreference = "Stop"
$pgCtl = Join-Path $env:LOCALAPPDATA "Programs\PostgreSQL\17\pgsql\bin\pg_ctl.exe"
$dataDir = Join-Path $env:LOCALAPPDATA "PostgreSQL\tradeloom\data"
if (-not (Test-Path -LiteralPath (Join-Path $dataDir "PG_VERSION"))) {
  Write-Output "postgres_instance=absent"
  exit 0
}
& $pgCtl -D $dataDir stop -m fast
if ($LASTEXITCODE -ne 0) { throw "pg_ctl stop failed" }
Write-Output "postgres_stopped=true"
