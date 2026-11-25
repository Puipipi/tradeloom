param([string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'))
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$config = Get-Content -LiteralPath (Join-Path $root 'server-config.json') -Raw | ConvertFrom-Json
foreach ($pair in @(@('install_root',''), @('app_root','app'), @('runtime_root','runtime'), @('postgres_data','postgres-data'))) {
  $expected = if ($pair[1]) { Join-Path $root $pair[1] } else { $root }
  if ([IO.Path]::GetFullPath([string]$config.($pair[0])).TrimEnd('\') -ine $expected) { throw 'Installation paths do not belong to DataRoot; nothing changed.' }
}
# Reject links in either tree: an update must never copy through a junction.
foreach ($path in @($root, $source)) {
  if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation/package root is not supported.' }
}
$app = Join-Path $root 'app'
if ($source -ieq $app -or $source.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Extract the new trusted Server package outside DataRoot.' }
foreach ($entry in @('config','workbench','enterprise_portal','manage.py')) {
  $entryPath = Join-Path $source $entry
  if (-not (Test-Path -LiteralPath $entryPath)) { throw "New package is incomplete: $entry" }
  foreach ($item in @((Get-Item -LiteralPath $entryPath)) + @(Get-ChildItem -LiteralPath $entryPath -Recurse -Force)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked package contents are not supported.' }
  }
}
$sha = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(([Security.Principal.WindowsIdentity]::GetCurrent().User.Value + $root.ToLowerInvariant())))).Replace('-','') } finally { $sha.Dispose() }
$mutex = New-Object Threading.Mutex($false, ('Global\TradeLoomServerStartup-' + $key))
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Another launcher is using this installation.' }
  # Require a cold installation; do not kill any process or send SQL to a port.
  $pidFile = Join-Path $root 'django.pid'
  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedPid)) { throw 'Invalid server PID; installation left unchanged.' }
    if (Get-Process -Id $savedPid -ErrorAction SilentlyContinue) { throw 'Stop the installed service before updating; no process was changed.' }
  }
  foreach ($port in @([int]$config.http_port, [int]$config.postgres_port)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw 'An installation port is listening; stop the service before updating.' }
  }
  $pgCtl = Join-Path $config.runtime_root 'postgresql\bin\pg_ctl.exe'
  & $pgCtl -D $config.postgres_data status 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { throw 'The installed database is running; stop it before updating.' }
  if ($LASTEXITCODE -ne 3) { throw 'Could not verify the installed database is stopped.' }
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -Force)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation contents are not supported.' }
  }
  $recovery = Join-Path $root ('upgrade-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $recovery | Out-Null
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $recovery /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect the recovery folder.' }
  $staged = Join-Path $recovery 'staged-app'
  New-Item -ItemType Directory -Path $staged | Out-Null
  foreach ($entry in @('config','workbench','enterprise_portal','manage.py')) { Copy-Item -LiteralPath (Join-Path $source $entry) -Destination $staged -Recurse }
  $runtimeData = Join-Path $app 'data\runtime'
  foreach ($directory in @('uploads', 'artifacts')) {
    $existingData = Join-Path $runtimeData $directory
    if (Test-Path -LiteralPath $existingData -PathType Container) {
      $stagedData = Join-Path $staged 'data\runtime'
      New-Item -ItemType Directory -Path $stagedData -Force | Out-Null
      Copy-Item -LiteralPath $existingData -Destination $stagedData -Recurse
    }
  }
  # Cold snapshot pairs the old code with its pre-migration database.
  Copy-Item -LiteralPath $config.postgres_data -Destination (Join-Path $recovery 'postgres-data') -Recurse
  Copy-Item -LiteralPath (Join-Path $root 'server-config.json') -Destination $recovery
  'prepared: old app and cold database must be recovered together; never restore code alone after migration.' | Set-Content -LiteralPath (Join-Path $recovery 'state.txt')
  Move-Item -LiteralPath $app -Destination (Join-Path $recovery 'app')
  try { Move-Item -LiteralPath $staged -Destination $app } catch {
    # No database migration has started; restore the old application only here.
    Move-Item -LiteralPath (Join-Path $recovery 'app') -Destination $app
    throw
  }
  'migration-starting: retain new app on failure; inspect private logs and recover old app/database together only while stopped.' | Set-Content -LiteralPath (Join-Path $recovery 'state.txt')
  try {
    & (Join-Path $PSScriptRoot 'Start-EnterpriseServer.ps1') -DataRoot $root
    'completed: new application started; pre-upgrade app/database retained.' | Set-Content -LiteralPath (Join-Path $recovery 'state.txt')
  } catch {
    throw "Upgrade/start failed. New app retained because migration may have run. Recovery pair: $recovery . Inspect private logs. $($_.Exception.Message)"
  }
  Write-Host "Application updated. Runtime, configuration, secrets and vault retained. Private recovery pair: $recovery"
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
