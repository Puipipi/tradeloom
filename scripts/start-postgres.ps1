param(
  [int]$Port = 55432
)

$ErrorActionPreference = "Stop"
$pgBin = Join-Path $env:LOCALAPPDATA "Programs\PostgreSQL\17\pgsql\bin"
$pgRoot = Join-Path $env:LOCALAPPDATA "PostgreSQL\tradeloom"
$dataDir = Join-Path $pgRoot "data"
$logDir = Join-Path $pgRoot "logs"
$passwordFile = Join-Path $pgRoot "superuser-password.txt"
$pgCtl = Join-Path $pgBin "pg_ctl.exe"
$initdb = Join-Path $pgBin "initdb.exe"
$psql = Join-Path $pgBin "psql.exe"
$pgIsReady = Join-Path $pgBin "pg_isready.exe"
$role = if ($env:TRADELOOM_DB_USER) { $env:TRADELOOM_DB_USER } else { "tradeloom" }

foreach ($path in @($pgCtl, $initdb, $psql, $pgIsReady)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "PostgreSQL binary missing: $path"
  }
}
New-Item -ItemType Directory -Force -Path $pgRoot, $logDir | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $dataDir "PG_VERSION"))) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $password = [Convert]::ToBase64String($bytes)
  Set-Content -LiteralPath $passwordFile -Value $password -NoNewline -Encoding utf8
  & icacls.exe $passwordFile /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
  & $initdb -D $dataDir -U $role --pwfile=$passwordFile --auth-host=scram-sha-256 --auth-local=scram-sha-256 --encoding=UTF8 --locale=C
  if ($LASTEXITCODE -ne 0) { throw "initdb failed" }
  Add-Content -LiteralPath (Join-Path $dataDir "postgresql.conf") -Value @"
listen_addresses = '127.0.0.1'
port = $Port
password_encryption = scram-sha-256
"@
}

$ready = & $pgIsReady -h 127.0.0.1 -p $Port
if ($LASTEXITCODE -ne 0) {
  & $pgCtl -D $dataDir -l (Join-Path $logDir "postgresql.log") -o "-p $Port -h 127.0.0.1" start
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed" }
}

$env:PGPASSWORD = Get-Content -LiteralPath $passwordFile -Raw
try {
  foreach ($database in @("tradeloom_dev", "tradeloom_lab", "tradeloom_test", "tradeloom_lab_test")) {
    $exists = (& $psql -h 127.0.0.1 -p $Port -U $role -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$database'" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "database lookup failed: $database" }
    if ($exists -ne "1") {
      & $psql -h 127.0.0.1 -p $Port -U $role -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $database"
      if ($LASTEXITCODE -ne 0) { throw "CREATE DATABASE failed: $database" }
    }
  }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

Write-Output "postgres_ready=true"
Write-Output "postgres_host=127.0.0.1"
Write-Output "postgres_port=$Port"
