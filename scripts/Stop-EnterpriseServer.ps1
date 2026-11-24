param([string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'))
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($DataRoot)
$configFile = Join-Path $root 'server-config.json'
if (-not (Test-Path -LiteralPath $configFile)) { Write-Host 'Enterprise server is not installed here.'; exit 0 }
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$python = Join-Path $config.runtime_root 'python\python.exe'
$appRoot = [string]$config.app_root
$httpPort = [int]$config.http_port
$pidFile = Join-Path $root 'django.pid'
if (Test-Path -LiteralPath $pidFile) {
  $serverPid = 0
  if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$serverPid)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -ErrorAction SilentlyContinue
    if ($process) {
      $scriptArg = $process.CommandLine.Contains((Join-Path $appRoot 'manage.py')) -or
        $process.CommandLine.Contains(' -B manage.py ')
      $owned = $process.ExecutablePath -eq $python -and
        $scriptArg -and
        $process.CommandLine.Contains("runserver 127.0.0.1:$httpPort")
      if (-not $owned) { throw 'Saved server PID belongs to another process; it was left untouched.' }
      Stop-Process -Id $serverPid -Force
      Wait-Process -Id $serverPid -Timeout 15 -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $pidFile -Force
}

$pgCtl = Join-Path (Join-Path $config.runtime_root 'postgresql\bin') 'pg_ctl.exe'
if (-not (Test-Path -LiteralPath $pgCtl)) { throw 'Enterprise PostgreSQL control binary is missing; database was left untouched.' }
& $pgCtl -D ([string]$config.postgres_data) status 2>$null
if ($LASTEXITCODE -eq 0) {
  & $pgCtl -D ([string]$config.postgres_data) -m fast stop
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the enterprise PostgreSQL instance.' }
}
Write-Host 'Enterprise web and its own PostgreSQL instance are stopped.'
