param(
  [ValidateSet('desktop', 'web')][string]$Mode = 'desktop',
  [string]$DataRoot,
  [string]$ErpNextConfigFile,
  [string]$Runtime
)
$ErrorActionPreference = 'Stop'
$runtimeProvided = $PSBoundParameters.ContainsKey('Runtime')
if ($runtimeProvided) {
  if ([string]::IsNullOrWhiteSpace($Runtime)) {
    throw 'Runtime 参数必须提供一个非空路径。'
  }
  if ($Runtime -match '["\r\n]' -or $Runtime -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
    throw 'Runtime 必须是无引号、无换行的绝对路径。'
  }
}
$erpNextConfigProvided = $PSBoundParameters.ContainsKey('ErpNextConfigFile')
if ($erpNextConfigProvided) {
  if ([string]::IsNullOrWhiteSpace($ErpNextConfigFile)) {
    throw 'ERPNext 配置参数必须提供一个非空文件路径。'
  }
  if ($ErpNextConfigFile -match '["\r\n]' -or -not [IO.Path]::IsPathRooted($ErpNextConfigFile)) {
    throw 'ERPNext 配置文件必须使用绝对路径。'
  }
}
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$entry = Join-Path $repoRoot 'apps\tradeloom-launcher\cli.mjs'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '未找到织贸助手运行所需的 Node.js。' }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '未找到织贸助手启动器文件。' }

$adapters = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface })
$candidates = @(
  foreach ($adapter in $adapters) {
    $name = $adapter.Name
    $description = $adapter.InterfaceDescription
    $kind = if ([int]$adapter.InterfaceType -eq 71 -or $adapter.PhysicalMediaType -match '802\.11') { 'wifi' }
      elseif ([int]$adapter.InterfaceType -eq 6 -or $adapter.PhysicalMediaType -eq '802.3' -or $adapter.MediaType -eq '802.3') { 'ethernet' }
      else { $null }
    if ($null -eq $kind) { continue }
    foreach ($address in (Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.AddressState -eq 'Preferred' })) {
      $value = $address.IPAddress
      if ($value -match '^10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -or
          $value -match '^192\.168\.(\d{1,3})\.(\d{1,3})$' -or
          $value -match '^172\.(1[6-9]|2\d|3[01])\.(\d{1,3})\.(\d{1,3})$') {
        [pscustomobject]@{
          name = $name
          interfaceDescription = $description
          kind = $kind
          status = 'Up'
          hardwareInterface = $true
          addresses = @([pscustomobject]@{ addressFamily = 'IPv4'; address = $value })
        }
      }
    }
  }
)
if ($candidates.Count -eq 0) {
  Write-Host '没有活动物理 Wi-Fi 或以太网网卡的私有 IPv4 地址，织贸助手尚未启动。'
  exit 2
}
$candidates = @($candidates | Sort-Object @{ Expression = { if ($_.kind -eq 'wifi') { 0 } else { 1 } } }, name)
$choice = 0
if ($candidates.Count -gt 1) {
  Write-Host '检测到多个活动局域网地址，请选择本次连接使用的网卡：'
  for ($i = 0; $i -lt $candidates.Count; $i++) {
    $candidate = $candidates[$i]
    Write-Host ("  {0}. {1} — {2} ({3})" -f ($i + 1), $candidate.name, $candidate.interfaceDescription, $candidate.addresses[0].address)
  }
  $answer = Read-Host '输入序号'
  if ($answer -notmatch '^\d+$' -or [int]$answer -lt 1 -or [int]$answer -gt $candidates.Count) {
    Write-Host '未选择有效网卡，织贸助手尚未启动。'
    exit 2
  }
  $choice = [int]$answer - 1
}
$hostIp = $candidates[$choice].addresses[0].address
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($candidates) -Depth 4 -Compress)))
$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = $node
$processInfo.WorkingDirectory = $repoRoot
$processInfo.UseShellExecute = $false
$processInfo.Arguments = '"' + $entry + '" start --mode ' + $Mode + ' --host "' + $hostIp + '" --candidates "' + $payload + '"'
if ($runtimeProvided) {
  $processInfo.Arguments += ' --runtime "' + $Runtime + '"'
}
if ($erpNextConfigProvided) {
  $processInfo.Arguments += ' --erpnext-config-file "' + $ErpNextConfigFile + '"'
}
if (Test-Path Env:TRADELOOM_DB_PASSWORD) {
  $processInfo.EnvironmentVariables['TRADELOOM_DB_PASSWORD'] = $env:TRADELOOM_DB_PASSWORD
} else {
  $passwordFile = Join-Path $env:LOCALAPPDATA 'PostgreSQL\tradeloom\superuser-password.txt'
  if (-not (Test-Path -LiteralPath $passwordFile -PathType Leaf)) {
    throw "缺少织贸助手本机 PostgreSQL 密码文件。请先按 docs/quick-start.md 准备专属 PostgreSQL；若数据库已有数据，请恢复原密码文件，不要重置数据库。"
  }
  $password = Get-Content -LiteralPath $passwordFile -Raw
  $processInfo.EnvironmentVariables['TRADELOOM_DB_PASSWORD'] = $password.TrimEnd([char[]]@(13, 10))
}
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
  $processInfo.EnvironmentVariables.Remove('TRADELOOM_DATA_ROOT')
} else {
  if ($DataRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') { throw 'DataRoot 必须是绝对 Windows 路径。' }
  $processInfo.EnvironmentVariables['TRADELOOM_DATA_ROOT'] = [IO.Path]::GetFullPath($DataRoot)
}
$process = [System.Diagnostics.Process]::Start($processInfo)
$process.WaitForExit()
exit $process.ExitCode
