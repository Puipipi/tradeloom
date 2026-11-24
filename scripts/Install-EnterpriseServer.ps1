param(
  [string]$RuntimeSource,
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [int]$Port = 27417,
  [string]$ExternalHttpsUrl = '',
  [int]$PostgresPort = 56427
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EnterpriseServerHttps.ps1')

function New-RandomHex([int]$Length) {
  $bytes = New-Object byte[] $Length
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Resolve-Runtime([string]$Source) {
  if (-not $Source) {
    $default = Join-Path $PSScriptRoot '..\enterprise-runtime-bundle'
    if (Test-Path -LiteralPath $default) { $Source = $default }
  }
  if (-not $Source) {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = 'Select a trusted TradeLoom Windows resources folder or prepared server runtime bundle.'
    $picker.ShowNewFolderButton = $false
    if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw 'Runtime selection was cancelled.' }
    $Source = $picker.SelectedPath
  }
  $Source = (Resolve-Path -LiteralPath $Source).Path

  $resourcesPython = Join-Path $Source 'runtime\primary-runtime\dependencies\python'
  $resourcesPackages = Join-Path $Source 'tradeloom\python-packages'
  $resourcesPostgres = Join-Path $Source 'tradeloom\postgresql\pgsql'
  if (Test-Path -LiteralPath (Join-Path $resourcesPython 'python.exe')) {
    return @{ Python = $resourcesPython; Packages = $resourcesPackages; Postgres = $resourcesPostgres }
  }

  $bundlePython = Join-Path $Source 'python'
  $bundlePackages = Join-Path $Source 'python-packages'
  $bundlePostgres = Join-Path $Source 'postgresql'
  if (Test-Path -LiteralPath (Join-Path $bundlePython 'python.exe')) {
    return @{ Python = $bundlePython; Packages = $bundlePackages; Postgres = $bundlePostgres }
  }
  throw 'Runtime source must contain Python, Django python-packages, and PostgreSQL 17 binaries.'
}

function Protect-UserData([string]$Path) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $Path /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the enterprise data folder ACL.' }
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$Failure) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}

if ($Port -lt 1024 -or $Port -gt 65535) { throw 'HTTP port must be between 1024 and 65535.' }
if ($PostgresPort -lt 1024 -or $PostgresPort -gt 65535) { throw 'PostgreSQL port must be between 1024 and 65535.' }
if ($PostgresPort -eq $Port) { throw 'PostgreSQL port must differ from the HTTP port.' }
if (Get-NetTCPConnection -State Listen -LocalPort $PostgresPort -ErrorAction SilentlyContinue) {
  throw "Private PostgreSQL port $PostgresPort is already in use; no data folder or existing service was changed."
}
$pgPort = $PostgresPort
$httpsConfiguration = Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl $ExternalHttpsUrl
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "HTTP port $Port is already in use; no existing service was changed."
}

$dataPath = [IO.Path]::GetFullPath($DataRoot)
$configFile = Join-Path $dataPath 'server-config.json'
if (Test-Path -LiteralPath $configFile) { throw "Enterprise server is already installed under $dataPath; use Start-EnterpriseServer.ps1." }
if (Test-Path -LiteralPath $dataPath) {
  $existing = @(Get-ChildItem -LiteralPath $dataPath -Force)
  if ($existing.Count -gt 0) { throw "DataRoot is not empty; existing files were left untouched: $dataPath" }
} else {
  New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
}
Protect-UserData $dataPath

$sourceRuntime = Resolve-Runtime $RuntimeSource
foreach ($required in @(
  (Join-Path $sourceRuntime.Packages 'django\__init__.py'),
  (Join-Path $sourceRuntime.Packages 'psycopg\__init__.py'),
  (Join-Path $sourceRuntime.Postgres 'bin\initdb.exe'),
  (Join-Path $sourceRuntime.Postgres 'bin\pg_ctl.exe'),
  (Join-Path $sourceRuntime.Postgres 'bin\psql.exe')
)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required runtime file is missing: $required" }
}

$appSource = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appRoot = Join-Path $dataPath 'app'
$runtimeRoot = Join-Path $dataPath 'runtime'
$pythonRoot = Join-Path $runtimeRoot 'python'
$packagesRoot = Join-Path $runtimeRoot 'python-packages'
$postgresRoot = Join-Path $runtimeRoot 'postgresql'
New-Item -ItemType Directory -Force -Path $appRoot, $runtimeRoot | Out-Null
foreach ($entry in @('config', 'workbench', 'enterprise_portal')) {
  Copy-Item -LiteralPath (Join-Path $appSource $entry) -Destination $appRoot -Recurse
}
Copy-Item -LiteralPath (Join-Path $appSource 'manage.py') -Destination $appRoot
Copy-Item -LiteralPath $sourceRuntime.Python -Destination $pythonRoot -Recurse
Copy-Item -LiteralPath $sourceRuntime.Packages -Destination $packagesRoot -Recurse
Copy-Item -LiteralPath $sourceRuntime.Postgres -Destination $postgresRoot -Recurse

$pgData = Join-Path $dataPath 'postgres-data'
$logRoot = Join-Path $dataPath 'logs'
$secretRoot = Join-Path $dataPath 'secrets'
New-Item -ItemType Directory -Force -Path $pgData, $logRoot, $secretRoot | Out-Null

$pgAdminPassword = New-RandomHex 32
$databasePassword = New-RandomHex 32
$djangoSecret = New-RandomHex 48
$pgAdminPasswordFile = Join-Path $secretRoot 'postgres-admin-password.txt'
$secretsFile = Join-Path $secretRoot 'service-secrets.json'
Set-Content -LiteralPath $pgAdminPasswordFile -Value $pgAdminPassword -NoNewline -Encoding ASCII
@{ django_secret_key = $djangoSecret; database_password = $databasePassword; database_user = 'tradeloom_enterprise'; database_name = 'tradeloom_enterprise' } |
  ConvertTo-Json | Set-Content -LiteralPath $secretsFile -Encoding UTF8
Protect-UserData $secretRoot
$config = @{
  app_root = $appRoot
  runtime_root = $runtimeRoot
  postgres_data = $pgData
  postgres_port = $pgPort
  http_port = $Port
  external_https_url = $ExternalHttpsUrl
  https_enabled = [bool]$httpsConfiguration.Enabled
  install_root = $dataPath
} | ConvertTo-Json
$config | Set-Content -LiteralPath $configFile -Encoding UTF8

$pgBin = Join-Path $postgresRoot 'bin'
Invoke-Checked (Join-Path $pgBin 'initdb.exe') @(
  '-D', $pgData, '-U', 'postgres', "--pwfile=$pgAdminPasswordFile",
  '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--encoding=UTF8', '--no-locale'
) 'PostgreSQL initialization failed.'
$configAppend = @"
listen_addresses = '127.0.0.1'
port = $pgPort
password_encryption = scram-sha-256
"@
Add-Content -LiteralPath (Join-Path $pgData 'postgresql.conf') -Value $configAppend -Encoding ASCII
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$pgCtlArgs = "-D `"$pgData`" -l `"$(Join-Path $logRoot 'postgresql.log')`" -o `"-h 127.0.0.1 -p $pgPort`" -w -t 10 start"
$pgStart = Start-Process -FilePath $pgCtl -ArgumentList $pgCtlArgs -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logRoot 'pgctl-start.log') `
  -RedirectStandardError (Join-Path $logRoot 'pgctl-start-error.log')
$null = $pgStart.Handle # Retain the process handle so PS5.1 preserves ExitCode.
# Wait for pg_ctl itself, not Start-Process -Wait (which can wait for its
# long-lived postgres child on Windows). pg_ctl owns the readiness timeout.
if (-not $pgStart.WaitForExit(15000)) { throw 'PostgreSQL startup timed out; inspect the private logs folder.' }
if ($pgStart.ExitCode -ne 0) { throw 'PostgreSQL startup failed; inspect the private logs folder.' }
& $pgCtl -D $pgData status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The private PostgreSQL process is not running; no SQL was sent.' }
$ownedPgPid = 0
$postmasterFile = Join-Path $pgData 'postmaster.pid'
if (-not (Test-Path -LiteralPath $postmasterFile) -or -not [int]::TryParse((Get-Content -LiteralPath $postmasterFile -TotalCount 1), [ref]$ownedPgPid)) { throw 'Cannot verify the private PostgreSQL PID; no SQL was sent.' }
$pgListeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $pgPort -State Listen -ErrorAction SilentlyContinue)
if ($ownedPgPid -le 0 -or $pgListeners.Count -ne 1 -or $pgListeners[0].OwningProcess -ne $ownedPgPid) { throw 'PostgreSQL listener ownership does not match this installation; no SQL was sent.' }

$env:PGPASSWORD = $pgAdminPassword
try {
  Invoke-Checked (Join-Path $pgBin 'psql.exe') @(
    '-h', '127.0.0.1', '-p', "$pgPort", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-c', "CREATE ROLE tradeloom_enterprise LOGIN PASSWORD '$databasePassword'"
  ) 'Could not create the enterprise database role.'
  Invoke-Checked (Join-Path $pgBin 'psql.exe') @(
    '-h', '127.0.0.1', '-p', "$pgPort", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-c', 'CREATE DATABASE tradeloom_enterprise OWNER tradeloom_enterprise'
  ) 'Could not create the enterprise database.'
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONPATH = $packagesRoot
$env:DJANGO_SETTINGS_MODULE = 'config.enterprise_settings'
$env:TRADELOOM_ENTERPRISE_SECRET_KEY = $djangoSecret
$allowedHosts = @('127.0.0.1', 'localhost')
if ($httpsConfiguration.Enabled) { $allowedHosts += $httpsConfiguration.Host }
$env:TRADELOOM_ENTERPRISE_ALLOWED_HOSTS = ($allowedHosts | Select-Object -Unique) -join ','
$env:TRADELOOM_ENTERPRISE_BIND_HOST = '127.0.0.1'
$env:TRADELOOM_ENTERPRISE_HTTPS = if ($httpsConfiguration.Enabled) { '1' } else { '0' }
$env:TRADELOOM_ENTERPRISE_CSRF_TRUSTED_ORIGINS = if ($httpsConfiguration.Enabled) { $httpsConfiguration.Origin } else { '' }
$env:TRADELOOM_ENTERPRISE_DATABASE_ALLOW_REMOTE = '0'
$env:TRADELOOM_DB_NAME = 'tradeloom_enterprise'
$env:TRADELOOM_DB_USER = 'tradeloom_enterprise'
$env:TRADELOOM_DB_PASSWORD = $databasePassword
$env:TRADELOOM_DB_HOST = '127.0.0.1'
$env:TRADELOOM_DB_PORT = "$pgPort"
Push-Location $appRoot
try {
  $python = Join-Path $pythonRoot 'python.exe'
  Invoke-Checked $python @('-B', 'manage.py', 'check') 'Django configuration check failed.'
  Invoke-Checked $python @('-B', 'manage.py', 'migrate', '--noinput') 'Database migrations failed.'
  Invoke-Checked $python @('-B', 'manage.py', 'configure_enterprise_groups') 'Default business groups setup failed.'
  Invoke-Checked $python @('-B', 'manage.py', 'createsuperuser') 'Boss administrator creation failed.'
} finally {
  Pop-Location
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

$config = @{
  app_root = $appRoot
  runtime_root = $runtimeRoot
  postgres_data = $pgData
  postgres_port = $pgPort
  http_port = $Port
  external_https_url = $ExternalHttpsUrl
  https_enabled = [bool]$httpsConfiguration.Enabled
  install_root = $dataPath
} | ConvertTo-Json
$config | Set-Content -LiteralPath $configFile -Encoding UTF8
Protect-UserData $dataPath

& (Join-Path $PSScriptRoot 'Start-EnterpriseServer.ps1') -DataRoot $dataPath
Write-Host "Local enterprise service: http://127.0.0.1:$Port/enterprise/"
if ($httpsConfiguration.Enabled) {
  Write-Host "Configured HTTPS origin: $($httpsConfiguration.Origin)"
  Write-Host "Client server address: $($httpsConfiguration.Origin)"
  Write-Host 'HTTPS mode is enabled for a separately managed reverse proxy. The installer does not create a proxy, tunnel, or DNS record.'
} elseif ($ExternalHttpsUrl) {
  Write-Host "Saved HTTPS handoff value: $ExternalHttpsUrl (HTTPS mode is disabled)."
}
