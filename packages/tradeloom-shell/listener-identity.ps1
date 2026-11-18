$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Emit-Result($listener, $firewall) {
  [pscustomobject]@{ listener = $listener; firewall = $firewall } | ConvertTo-Json -Compress -Depth 8
}

function Empty-Listener([int]$port, [string]$status, $code = $null, $addresses = @(), $candidatePids = @()) {
  return [pscustomobject]@{
    status = $status
    port = $port
    addresses = @($addresses)
    candidatePids = @($candidatePids)
    pid = $null
    executablePath = $null
    createdAt = $null
    sha256 = $null
    fileVersion = $null
    productVersion = $null
    errorCode = $code
  }
}

function Empty-Firewall([string]$status, $code = $null, $rules = @()) {
  return [pscustomobject]@{ status = $status; rules = @($rules); errorCode = $code }
}

function Get-TcpRows([int]$port) {
  return @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop |
    Select-Object LocalAddress, LocalPort, OwningProcess)
}

function Get-ProcessRows([uint32]$processId) {
  return @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop |
    Select-Object ProcessId, ExecutablePath, CreationDate)
}

function Normalize-CreationDate($value) {
  if ($value -is [datetime]) { return $value.ToUniversalTime().ToString('o') }
  try { return [Management.ManagementDateTimeConverter]::ToDateTime([string]$value).ToUniversalTime().ToString('o') } catch { return $null }
}

function Tcp-Signature($rows) {
  return (@($rows | ForEach-Object { '{0}|{1}|{2}' -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess } | Sort-Object) -join "`n")
}

$request = $null
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
  $propertyNames = @($request.PSObject.Properties | ForEach-Object { $_.Name })
  if ($null -eq $request -or $request -is [System.Array] -or $propertyNames.Count -ne 1 -or
      $propertyNames[0] -ne 'port' -or -not ($request.port -is [int] -or $request.port -is [long]) -or
      $request.port -lt 1 -or $request.port -gt 65535) {
    Emit-Result (Empty-Listener 1 'unknown' 'invalid_request') (Empty-Firewall 'not_checked')
    exit 0
  }
  $port = [int]$request.port
} catch {
  Emit-Result (Empty-Listener 1 'unknown' 'invalid_request') (Empty-Firewall 'not_checked')
  exit 0
}

try { $firstRows = @(Get-TcpRows $port) } catch {
  if ($_.FullyQualifiedErrorId -ceq 'CmdletizationQuery_NotFound,Get-NetTCPConnection' -and
      [string]$_.CategoryInfo.Category -ceq 'ObjectNotFound') {
    Emit-Result (Empty-Listener $port 'not_listening' $null) (Empty-Firewall 'not_checked')
  } else {
    Emit-Result (Empty-Listener $port 'unknown' 'tcp_query_failed') (Empty-Firewall 'not_checked')
  }
  exit 0
}
if ($firstRows.Count -eq 0) {
  Emit-Result (Empty-Listener $port 'not_listening' $null) (Empty-Firewall 'not_checked')
  exit 0
}

$ownerIds = @($firstRows | ForEach-Object { [uint32]$_.OwningProcess } | Sort-Object -Unique)
$addresses = @($firstRows | ForEach-Object { [string]$_.LocalAddress } | Sort-Object -Unique)
if ($ownerIds.Count -ne 1) {
  Emit-Result (Empty-Listener $port 'ambiguous' 'multiple_owners' $addresses $ownerIds) (Empty-Firewall 'not_checked')
  exit 0
}
$ownerId = [uint32]$ownerIds[0]

try { $processRows = @(Get-ProcessRows $ownerId) } catch {
  Emit-Result (Empty-Listener $port 'unknown' 'process_query_failed' $addresses @($ownerId)) (Empty-Firewall 'not_checked')
  exit 0
}
if ($processRows.Count -ne 1) {
  Emit-Result (Empty-Listener $port 'unknown' 'process_unavailable' $addresses @($ownerId)) (Empty-Firewall 'not_checked')
  exit 0
}
$process = $processRows[0]
if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
  Emit-Result (Empty-Listener $port 'unknown' 'executable_unavailable' $addresses @($ownerId)) (Empty-Firewall 'not_checked')
  exit 0
}
$exe = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
try {
  Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
  $hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
} catch {
  Emit-Result (Empty-Listener $port 'unknown' 'executable_hash_failed' $addresses @($ownerId)) (Empty-Firewall 'not_checked')
  exit 0
}
$versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
$created = Normalize-CreationDate $process.CreationDate
if ([string]::IsNullOrWhiteSpace($created)) {
  Emit-Result (Empty-Listener $port 'unknown' 'process_identity_incomplete' $addresses @($ownerId)) (Empty-Firewall 'not_checked')
  exit 0
}

$firewall = $null
try {
  Import-Module NetSecurity -ErrorAction Stop
  $filters = @(Get-NetFirewallApplicationFilter -Program $exe -PolicyStore ActiveStore -ErrorAction Stop |
    Where-Object { $_.Program -and [IO.Path]::GetFullPath([string]$_.Program).Equals($exe, [StringComparison]::OrdinalIgnoreCase) })
  $rules = @()
  foreach ($filter in $filters) {
    $rules += @(Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $filter -PolicyStore ActiveStore -ErrorAction Stop |
      ForEach-Object {
        [pscustomobject]@{
          name = [string]$_.Name
          enabled = [string]$_.Enabled
          direction = [string]$_.Direction
          action = [string]$_.Action
          profile = [string]$_.Profile
          policyStoreSourceType = [string]$_.PolicyStoreSourceType
          policyStoreSource = [string]$_.PolicyStoreSource
        }
      })
  }
  $firewall = Empty-Firewall 'observed' $null $rules
} catch {
  if ($_.FullyQualifiedErrorId -ceq 'CmdletizationQuery_NotFound_AppPath,Get-NetFirewallApplicationFilter' -and
      [string]$_.CategoryInfo.Category -ceq 'ObjectNotFound') {
    $firewall = Empty-Firewall 'observed' $null @()
  } else {
    $firewall = Empty-Firewall 'unknown' 'firewall_query_failed'
  }
}

try {
  $lastRows = @(Get-TcpRows $port)
  $lastProcessRows = @(Get-ProcessRows $ownerId)
  Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
  $lastHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  $lastCreated = if ($lastProcessRows.Count -eq 1) { Normalize-CreationDate $lastProcessRows[0].CreationDate } else { $null }
  if ((Tcp-Signature $firstRows) -cne (Tcp-Signature $lastRows) -or
      $lastProcessRows.Count -ne 1 -or
      [uint32]$lastProcessRows[0].ProcessId -ne $ownerId -or
      [string]$lastProcessRows[0].ExecutablePath -cne $exe -or
      $lastHash -cne $hash -or
      $null -eq $lastCreated -or
      $lastCreated -cne $created) {
    Emit-Result (Empty-Listener $port 'unknown' 'identity_changed' $addresses @($ownerId)) (Empty-Firewall 'unknown' 'identity_changed')
    exit 0
  }
} catch {
  Emit-Result (Empty-Listener $port 'unknown' 'identity_changed' $addresses @($ownerId)) (Empty-Firewall 'unknown' 'identity_changed')
  exit 0
}

$listener = [pscustomobject]@{
  status = 'observed'
  port = $port
  addresses = $addresses
  candidatePids = @($ownerId)
  pid = $ownerId
  executablePath = $exe
  createdAt = $created
  sha256 = $hash
  fileVersion = if ([string]::IsNullOrWhiteSpace($versionInfo.FileVersion)) { $null } else { [string]$versionInfo.FileVersion }
  productVersion = if ([string]::IsNullOrWhiteSpace($versionInfo.ProductVersion)) { $null } else { [string]$versionInfo.ProductVersion }
  errorCode = $null
}
Emit-Result $listener $firewall
