param(
  [ValidateSet('status','start','create','open','mail','manage-status','manage-start','manage-stop','manage-restart')][string]$Action = 'status',
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [string]$RuntimeSource = '',
  [int]$Port = 27417,
  [int]$PostgresPort = 56427
)
$operation = $Action
$ErrorActionPreference = 'Stop'
$management = $operation.StartsWith('manage-')
if ($management) { $operation = $operation.Substring(7) }
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'EnterpriseServerHttps.ps1')
$root = [IO.Path]::GetFullPath($DataRoot)
$configFile = Join-Path $root 'server-config.json'
$startupMutex = $null
$startupLock = $false

function Assert-ProcessOwner($Process) {
  $owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction Stop
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw '服务进程 Windows 账号归属不符；未操作该进程。' }
}
function Assert-DatabaseOwner($Config) {
  $pgListeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ([int]$Config.postgres_port) -State Listen -ErrorAction SilentlyContinue)
  $pgPidFile = Join-Path $Config.postgres_data 'postmaster.pid'
  $pgPid = 0
  if (Test-Path -LiteralPath $pgPidFile) { $null = [int]::TryParse((Get-Content -LiteralPath $pgPidFile -TotalCount 1), [ref]$pgPid) }
  $pgProcess = if ($pgPid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId=$pgPid" -ErrorAction SilentlyContinue } else { $null }
  if ($pgProcess) {
    if ($pgProcess.ExecutablePath -ine (Join-Path $Config.runtime_root 'postgresql\bin\postgres.exe') -or -not $pgProcess.CommandLine.Replace('/','\').Contains(([string]$Config.postgres_data).Replace('/','\'))) { throw '数据库进程路径或数据目录归属不符。' }
    Assert-ProcessOwner $pgProcess
    if ($pgListeners.Count -ne 1 -or $pgListeners[0].OwningProcess -ne $pgPid) { throw '数据库端口归属不符；未执行管理员操作。' }
    return $true
  }
  if ($pgListeners.Count -gt 0) { throw '数据库端口由其他进程占用；未操作该进程。' }
  return $false
}
function Get-OwnedState([switch]$AllowUnhealthy) {
  $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
  if ([IO.Path]::GetFullPath([string]$config.install_root).TrimEnd('\') -ine $root.TrimEnd('\')) { throw '配置归属与数据目录不符；未修改现有安装。' }
  foreach ($pair in @(@('app_root','app'), @('runtime_root','runtime'), @('postgres_data','postgres-data'))) {
    if ([IO.Path]::GetFullPath([string]$config.($pair[0])).TrimEnd('\') -ine (Join-Path $root $pair[1]).TrimEnd('\')) { throw '配置中的应用、运行库或数据库目录归属不符；未操作现有安装。' }
  }
  $databaseRunning = Assert-DatabaseOwner $config
  $python = Join-Path $config.runtime_root 'python\python.exe'
  $pidFile = Join-Path $root 'django.pid'
  $owned = $false
  if (Test-Path -LiteralPath $pidFile) {
    $serverPid = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$serverPid)) { throw '服务 PID 文件无效；未修改现有安装。' }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -ErrorAction SilentlyContinue
    if ($process) {
      $scriptArg = $process.CommandLine.Contains((Join-Path $config.app_root 'manage.py')) -or $process.CommandLine.Contains(' -B manage.py ')
      $owned = $process.ExecutablePath -ieq $python -and $scriptArg -and $process.CommandLine.Contains("runserver 127.0.0.1:$($config.http_port)")
      if (-not $owned) { throw '保存的服务 PID 属于其他进程；未操作该进程。' }
      Assert-ProcessOwner $process
    }
  }
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$config.http_port) -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0 -and (-not $owned -or @($listeners | Where-Object OwningProcess -ne $serverPid).Count -gt 0)) { throw 'HTTP 端口由其他进程占用；未操作该进程。' }
  if (-not $owned) { return @{ installed=$true; running=$false; database_running=$databaseRunning; healthy=$false; has_admin=$false; message='服务尚未启动。点击“启动服务”后检查管理员。' } }
  $httpsEnabled = Get-EnterpriseHttpsEnabled -Configuration $config
  $authority = ''
  if ($httpsEnabled) { $authority = (Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl ([string]$config.external_https_url)).Authority }
  $healthy = Test-EnterpriseServerHealthMode -Port ([int]$config.http_port) -HttpsEnabled $httpsEnabled -PublicAuthority $authority
  if (-not $healthy -and -not $AllowUnhealthy) { throw '本安装的服务进程存在，但健康检查失败；未停止或重启服务。' }
  if (-not $databaseRunning -and -not $AllowUnhealthy) { throw '本安装数据库未运行；未执行管理员操作。' }
  return @{ installed=$true; running=$true; database_running=$databaseRunning; healthy=($healthy -and $databaseRunning); config=$config; python=$python }
}
function Invoke-AdminHelper($State, [string]$Operation, [string]$Payload = '') {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $State.python
  $info.Arguments = '-B "' + (Join-Path $PSScriptRoot 'server-gui-admin.py') + '" "' + $root + '" ' + $Operation
  $info.WorkingDirectory = $State.config.app_root
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables['PYTHONDONTWRITEBYTECODE'] = '1'
  $info.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  $null = $process.Start()
  if ($Payload) {
    $inputBytes = [Text.Encoding]::UTF8.GetBytes($Payload + [char]10)
    $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $process.StandardInput.BaseStream.Flush()
    [Array]::Clear($inputBytes, 0, $inputBytes.Length)
  }
  $process.StandardInput.Close()
  $outputTask = $process.StandardOutput.ReadToEndAsync()
  $errorTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(30000)) { $process.Kill(); throw '管理员检查超时；请刷新状态核实实际结果。' }
  $output = $outputTask.GetAwaiter().GetResult()
  $null = $errorTask.GetAwaiter().GetResult()
  $process.Dispose()
  try { return ($output | ConvertFrom-Json) } catch { throw '管理员助手未返回有效结果；未输出账号信息。' }
}
try {
  if ($management -and $operation -in @('stop','restart')) {
    $confirmation = [Console]::ReadLine() | ConvertFrom-Json
    if (@($confirmation.PSObject.Properties).Count -ne 1 -or $confirmation.confirmed -isnot [bool] -or -not $confirmation.confirmed) { throw '停止或重启需要在管理助手中明确确认；服务未变更。' }
  }
  if ($operation -in @('start','stop','restart')) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $mutexKey = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(([Security.Principal.WindowsIdentity]::GetCurrent().User.Value + $root.ToLowerInvariant())))).Replace('-','') } finally { $sha.Dispose() }
    $startupMutex = New-Object Threading.Mutex($false, ('Global\TradeLoomServerStartup-' + $mutexKey))
    try { $startupLock = $startupMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $startupLock = $true }
    if (-not $startupLock) { throw '此数据目录正在由另一个启动器准备服务，请稍后刷新状态。' }
  }
  if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    if (Test-Path -LiteralPath $root) {
      if (@(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) { throw '数据目录非空但缺少安装配置，可能是未完成安装。已保留全部文件；请另选空目录，或由管理员核查并备份后处理。' }
    }
    if ($operation -ne 'start') { @{ ok=$true; installed=$false; running=$false; has_admin=$false; message='尚未安装。点击“启动服务”准备本机服务，再自行创建首个管理员。' } | ConvertTo-Json -Compress; exit 0 }
    if (-not $RuntimeSource) { $RuntimeSource = Join-Path $PSScriptRoot '..\enterprise-runtime-bundle' }
    if (-not (Test-Path -LiteralPath $RuntimeSource -PathType Container)) { throw '缺少服务运行库。请使用完整服务器包，或通过 -RuntimeSource 指定受信运行库目录。' }
    & (Join-Path $PSScriptRoot 'Install-EnterpriseServer.ps1') -DataRoot $root -RuntimeSource $RuntimeSource -Port $Port -PostgresPort $PostgresPort -DeferAdministratorSetup *> $null
  }
  $state = Get-OwnedState -AllowUnhealthy:$management
  if ($management -and $operation -in @('stop','restart')) {
    & (Join-Path $PSScriptRoot 'Stop-EnterpriseServer.ps1') -DataRoot $root *> $null
    $state = Get-OwnedState -AllowUnhealthy
    if ($state.running -or $state.database_running) { throw '停止后仍检测到本安装服务；未继续重启，请刷新状态。' }
  }
  if ($operation -in @('start','restart')) {
    & (Join-Path $PSScriptRoot 'Start-EnterpriseServer.ps1') -DataRoot $root *> $null
    $state = Get-OwnedState
  }
  if ($management) {
    $message = if ($state.running -and $state.healthy) { '本安装网页服务和数据库运行正常，健康检查通过。' } elseif ($state.running) { '本安装网页进程存在，但健康检查未通过；可确认停止或重启。' } elseif ($state.database_running) { '网页服务未运行，数据库仍在运行；可启动或确认停止。' } else { '本安装网页服务和数据库均已停止。' }
    @{ok=$true; installed=$true; running=[bool]$state.running; database_running=[bool]$state.database_running; healthy=[bool]$state.healthy; message=$message} | ConvertTo-Json -Compress
    exit 0
  }
  if (-not $state.running) {
    if ($operation -in @('create','open','mail')) { throw '请先启动本安装的服务。' }
    $state.ok=$true; $state | ConvertTo-Json -Compress; exit 0
  }
  if ($operation -in @('create','mail')) {
    $payload = [Console]::ReadLine()
    $result = Invoke-AdminHelper $state $operation $payload
    $payload = $null
  } else { $result = Invoke-AdminHelper $state 'status' }
  if (-not $result.ok) { $result | ConvertTo-Json -Compress; exit 1 }
  if ($operation -eq 'open') {
    if (-not $result.has_admin) { throw '请先自行创建首个管理员。' }
    & (Join-Path $PSScriptRoot 'Open-ServerConsole.ps1') -DataRoot $root *> $null
  }
  @{ ok=$true; installed=$true; running=$true; has_admin=[bool]$result.has_admin; smtp_configured=[bool]$result.smtp_configured; message= $(if ($operation -eq 'mail') { '登录安全设置已保存；未创建业务登录会话。' } elseif ($operation -eq 'create') { '首个管理员已创建。请先配置验证码发信，再使用两步登录。' } elseif ($result.has_admin) { '服务运行正常。可在“登录安全设置”补绑账号邮箱和配置发信。' } else { '服务运行正常。请在下方自行填写首个管理员账号、邮箱和密码。' }) } | ConvertTo-Json -Compress
} catch {
  @{ ok=$false; message=$_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
finally {
  if ($startupLock) { $startupMutex.ReleaseMutex() }
  if ($null -ne $startupMutex) { $startupMutex.Dispose() }
}
