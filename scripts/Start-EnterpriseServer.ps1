param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [switch]$EnableHttps,
  [switch]$DisableHttps,
  [string]$ExternalHttpsUrl = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'EnterpriseServerHttps.ps1')

if ($EnableHttps -and $DisableHttps) { throw 'Choose either -EnableHttps or -DisableHttps.' }
if ($ExternalHttpsUrl -and -not $EnableHttps) { throw 'Pass -ExternalHttpsUrl only together with -EnableHttps.' }

$root = [IO.Path]::GetFullPath($DataRoot)
$configFile = Join-Path $root 'server-config.json'
$secretsFile = Join-Path $root 'secrets\service-secrets.json'
if (-not (Test-Path -LiteralPath $configFile) -or -not (Test-Path -LiteralPath $secretsFile)) {
  throw 'Enterprise server is not installed. Run Install-EnterpriseServer.ps1 first.'
}
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$secrets = Get-Content -LiteralPath $secretsFile -Raw | ConvertFrom-Json
$pidFile = Join-Path $root 'django.pid'

$previousHttpsEnabled = Get-EnterpriseHttpsEnabled -Configuration $config
$previousHttpsUrl = [string]$config.external_https_url
$nextHttpsEnabled = $previousHttpsEnabled
$nextHttpsUrl = $previousHttpsUrl
if ($EnableHttps) {
  if ([string]::IsNullOrEmpty($ExternalHttpsUrl)) { $ExternalHttpsUrl = $previousHttpsUrl }
  $selectedHttps = Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl $ExternalHttpsUrl
  if (-not $selectedHttps.Enabled) { throw 'HTTPS mode requires -ExternalHttpsUrl or an HTTPS URL saved during installation.' }
  $nextHttpsEnabled = $true
  $nextHttpsUrl = $selectedHttps.Url
} elseif ($DisableHttps) {
  $nextHttpsEnabled = $false
}

$httpsConfiguration = if ($nextHttpsEnabled) {
  Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl $nextHttpsUrl
} else {
  Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl ''
}
if ($nextHttpsEnabled -and -not $httpsConfiguration.Enabled) {
  throw 'The saved HTTPS mode requires a valid ExternalHttpsUrl. Use -DisableHttps to return to local HTTP mode.'
}

$httpsSettingsChanged = ($previousHttpsEnabled -ne $nextHttpsEnabled) -or ($previousHttpsUrl -cne $nextHttpsUrl)
if ($httpsSettingsChanged) {
  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) {
      $liveProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
      if ($liveProcess) {
        throw 'A process is live for the saved server PID; HTTPS settings were left unchanged. Verify ownership and stop this install before changing its mode or public URL.'
      }
    }
  }
  $httpPort = [int]$config.http_port
  if (Get-NetTCPConnection -State Listen -LocalPort $httpPort -ErrorAction SilentlyContinue) {
    throw "HTTP port $httpPort is listening; HTTPS settings were left unchanged. Stop the service or resolve the port owner first."
  }
  if ($EnableHttps) {
    Set-EnterpriseHttpsMode -Configuration $config -Enabled $true -ExternalHttpsUrl $nextHttpsUrl
  } else {
    Set-EnterpriseHttpsMode -Configuration $config -Enabled $false
  }
  Write-EnterpriseServerConfiguration -Path $configFile -Configuration $config
}

$httpsEnabled = Get-EnterpriseHttpsEnabled -Configuration $config
$httpsConfiguration = if ($httpsEnabled) {
  Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl ([string]$config.external_https_url)
} else {
  Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl ''
}
if ($httpsEnabled -and -not $httpsConfiguration.Enabled) {
  throw 'The saved HTTPS mode requires a valid ExternalHttpsUrl. Use -DisableHttps to return to local HTTP mode.'
}

$python = Join-Path $config.runtime_root 'python\python.exe'
$pgBin = Join-Path $config.runtime_root 'postgresql\bin'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$pgReady = Join-Path $pgBin 'pg_isready.exe'
$pgData = [string]$config.postgres_data
$appRoot = [string]$config.app_root
$httpPort = [int]$config.http_port
$pgPort = [int]$config.postgres_port
$logRoot = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
foreach ($file in @($python, $pgCtl, $pgReady, (Join-Path $appRoot 'manage.py'), $pgData)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Enterprise installation file is missing: $file" }
}

$allowedHosts = @('127.0.0.1', 'localhost')
if ($httpsEnabled) { $allowedHosts += $httpsConfiguration.Host }
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONPATH = Join-Path $config.runtime_root 'python-packages'
$env:DJANGO_SETTINGS_MODULE = 'config.enterprise_settings'
$env:TRADELOOM_ENTERPRISE_SECRET_KEY = [string]$secrets.django_secret_key
$env:TRADELOOM_ENTERPRISE_ALLOWED_HOSTS = ($allowedHosts | Select-Object -Unique) -join ','
$env:TRADELOOM_ENTERPRISE_BIND_HOST = '127.0.0.1'
$env:TRADELOOM_ENTERPRISE_HTTPS = if ($httpsEnabled) { '1' } else { '0' }
$env:TRADELOOM_ENTERPRISE_CSRF_TRUSTED_ORIGINS = if ($httpsEnabled) { $httpsConfiguration.Origin } else { '' }
$env:TRADELOOM_ENTERPRISE_DATABASE_ALLOW_REMOTE = '0'
$env:TRADELOOM_DB_NAME = [string]$secrets.database_name
$env:TRADELOOM_DB_USER = [string]$secrets.database_user
$env:TRADELOOM_DB_PASSWORD = [string]$secrets.database_password
$env:TRADELOOM_DB_HOST = '127.0.0.1'
$env:TRADELOOM_DB_PORT = "$pgPort"

if (Test-Path -LiteralPath $pidFile) {
  $savedPid = 0
  if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) {
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
    if ($existing) {
      $scriptArg = $existing.CommandLine.Contains((Join-Path $appRoot 'manage.py')) -or
        $existing.CommandLine.Contains(' -B manage.py ')
      $owned = $existing.ExecutablePath -eq $python -and
        $scriptArg -and
        $existing.CommandLine.Contains("runserver 127.0.0.1:$httpPort")
      if (-not $owned) { throw 'Saved server PID belongs to another process; it was left untouched.' }
      if (Test-EnterpriseServerHealthMode -Port $httpPort -HttpsEnabled $httpsEnabled -PublicAuthority $httpsConfiguration.Authority) {
        if ($httpsEnabled) { Write-Host "Enterprise server is already running for HTTPS origin $($httpsConfiguration.Origin)" }
        else { Write-Host "Enterprise server is already running at http://127.0.0.1:$httpPort/enterprise/" }
        return
      }
      throw 'The owned server process is unhealthy or running with a different HTTP/HTTPS mode; stop it before changing modes.'
    }
  }
  Remove-Item -LiteralPath $pidFile -Force
}

$pgStatus = & $pgCtl -D $pgData status 2>$null
if ($LASTEXITCODE -ne 0) {
  if (Get-NetTCPConnection -State Listen -LocalPort $pgPort -ErrorAction SilentlyContinue) {
    throw "PostgreSQL port $pgPort is already used by another process; no existing service was changed."
  }
  $pgCtlArgs = "-D `"$pgData`" -l `"$(Join-Path $logRoot 'postgresql.log')`" -o `"-h 127.0.0.1 -p $pgPort`" start"
  $pgStart = Start-Process -FilePath $pgCtl -ArgumentList $pgCtlArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot 'pgctl-start.log') `
    -RedirectStandardError (Join-Path $logRoot 'pgctl-start-error.log')
}
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  & $pgReady -h 127.0.0.1 -p $pgPort | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  if ($pgStart -and $pgStart.HasExited -and $pgStart.ExitCode -ne 0) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $ready) { throw 'The enterprise PostgreSQL instance did not become ready.' }

Push-Location $appRoot
try {
  & $python -B manage.py migrate --noinput
  if ($LASTEXITCODE -ne 0) { throw 'Enterprise database migration failed.' }
  & $python -B manage.py configure_enterprise_groups
  if ($LASTEXITCODE -ne 0) { throw 'Enterprise group setup failed.' }
} finally { Pop-Location }

$manageScript = '"' + (Join-Path $appRoot 'manage.py') + '"'
$arguments = @('-B', $manageScript, 'runserver', "127.0.0.1:$httpPort", '--noreload', '--insecure')
$server = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $logRoot 'django-server.log') `
  -RedirectStandardError (Join-Path $logRoot 'django-server-error.log')
$server.Id | Set-Content -LiteralPath $pidFile -Encoding ASCII

$healthy = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  if (Test-EnterpriseServerHealthMode -Port $httpPort -HttpsEnabled $httpsEnabled -PublicAuthority $httpsConfiguration.Authority) {
    $healthy = $true
    break
  }
  if ($server.HasExited) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $healthy) { throw 'The enterprise web service did not become healthy in the configured HTTP/HTTPS mode; inspect the private logs folder.' }
if ($httpsEnabled) {
  Write-Host "Enterprise server is ready for HTTPS reverse proxy at http://127.0.0.1:$httpPort/ (PID $($server.Id))."
  Write-Host "HTTPS origin: $($httpsConfiguration.Origin)"
  Write-Host "Client server address: $($httpsConfiguration.Origin)"
  Write-Host 'Configure the trusted loopback reverse proxy to preserve Host and set X-Forwarded-Proto: https.'
} else {
  Write-Host "Enterprise server is ready at http://127.0.0.1:$httpPort/enterprise/ (PID $($server.Id))."
  if ($config.external_https_url) { Write-Host "Saved HTTPS handoff value: $($config.external_https_url) (HTTPS mode is disabled)." }
}
