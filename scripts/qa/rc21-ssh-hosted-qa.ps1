[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$script:stage = 'runner-preflight'
$script:workRoot = $null
$script:sshdConfig = $null
$script:serviceStartedByQa = $false
$script:testUserName = $null
$script:testUserSid = $null
$script:authRoot = $null
$script:exitCode = 0

function Write-QaStatus([string]$Message) {
  Write-Output $Message
}

function Assert-NoReparsePoint([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'A required path is a reparse point.'
    }
  }
}

function Get-FreeLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Invoke-QuietNative([string]$Executable, [string[]]$Arguments, [string]$FailureMessage) {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $null = & $Executable @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($code -ne 0) { throw $FailureMessage }
}

function Set-DirectoryAcl([string]$Path, [Security.Principal.SecurityIdentifier]$Owner,
                          [object[]]$Entries) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($Owner)
  foreach ($entry in $Entries) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $entry.Sid, $entry.Rights,
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    $null = $acl.AddAccessRule($rule)
  }
  if (Test-Path -LiteralPath $Path -PathType Container) {
    [IO.Directory]::SetAccessControl($Path, $acl)
  } else {
    [void][IO.Directory]::CreateDirectory($Path, $acl)
  }
}

function Set-AuthorizedKeysAcl([string]$Path, [Security.Principal.SecurityIdentifier]$Owner,
                               [Security.Principal.SecurityIdentifier]$ServiceSid) {
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($Owner)
  $ownerRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $Owner, [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow)
  $serviceRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $ServiceSid, [Security.AccessControl.FileSystemRights]::Read,
    [Security.AccessControl.AccessControlType]::Allow)
  $null = $acl.AddAccessRule($ownerRule)
  $null = $acl.AddAccessRule($serviceRule)
  [IO.File]::SetAccessControl($Path, $acl)
}

function Test-LocalTcpListener([int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync([Net.IPAddress]::Loopback, $Port)
    if (-not $task.Wait(5000)) { throw 'The loopback SSH listener did not accept a connection.' }
    if ($client.Client.RemoteEndPoint.Address.ToString() -ne '127.0.0.1') {
      throw 'SSH connected outside IPv4 loopback.'
    }
  } finally {
    $client.Dispose()
  }
}

function Invoke-SyntheticSsh([string]$SshExe, [string]$PrivateKey, [string]$KnownHosts,
                             [string]$UserName, [int]$Port, [bool]$ExpectSuccess) {
  Test-LocalTcpListener -Port $Port
  $sshArgs = @(
    '-i', $PrivateKey,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', "UserKnownHostsFile=$KnownHosts",
    '-o', 'GlobalKnownHostsFile=NUL',
    '-o', 'ConnectTimeout=5',
    '-p', [string]$Port,
    '-l', $UserName,
    '127.0.0.1',
    'exit 0'
  )
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $SshExe @sshArgs 2>&1)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($ExpectSuccess) {
    if ($code -ne 0) { throw 'The synthetic public-key SSH connection was not accepted.' }
    return
  }
  $text = $output -join "`n"
  if ($code -eq 0 -or $text -notmatch 'Permission denied') {
    throw 'The synthetic SSH denial did not match the expected authorization refusal.'
  }
}

try {
  $script:stage = 'runner-guard'
  if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
      $env:GITHUB_REPOSITORY -ine 'Puipipi/tradeloom' -or
      $env:GITHUB_REF -cne 'refs/heads/qa/enterprise-ssh-rc21-hosted') {
    throw 'This QA script is restricted to its dedicated GitHub-hosted repository branch.'
  }
  if (-not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'The hosted runner temporary directory is unavailable.'
  }
  Assert-NoReparsePoint -Path $env:RUNNER_TEMP
  $runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
  if ($runnerTemp -ine [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')) {
    throw 'The hosted runner temporary path did not resolve to its canonical location.'
  }
  $script:workRoot = Join-Path $runnerTemp ('tradeloom-ssh-qa-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($script:workRoot)
  Assert-NoReparsePoint -Path $script:workRoot
  if ((Split-Path -Parent (Resolve-Path -LiteralPath $script:workRoot).Path) -ine $runnerTemp) {
    throw 'The QA workspace escaped the hosted runner temporary directory.'
  }

  $script:stage = 'download-package'
  $releaseUrl = 'https://github.com/Puipipi/tradeloom/releases/download/v6.18.0-rc.21/TradeLoom-Server-Windows-x64-v6.18.0-rc.21-preview.zip'
  $expectedHash = '7cc765a4f8c0e2f0b9f6efd1490a6c8e89fffece867dceb3027e8b40093e3c62'
  $archive = Join-Path $script:workRoot 'TradeLoom-Server-Windows-x64-v6.18.0-rc.21-preview.zip'
  Invoke-WebRequest -Uri $releaseUrl -OutFile $archive -TimeoutSec 180 -UseBasicParsing
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -cne $expectedHash) { throw 'The published RC21 package SHA-256 did not match.' }
  Write-QaStatus 'PACKAGE_SHA256_VERIFIED'

  $archiveRoot = Join-Path $script:workRoot 'package'
  Expand-Archive -LiteralPath $archive -DestinationPath $archiveRoot -Force
  $packageRoot = Join-Path $archiveRoot 'Server'
  if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
    throw 'The verified RC21 archive has no Server payload directory.'
  }
  $manageScript = Join-Path $packageRoot 'Manage-SshAccess.ps1'
  $pythonExe = Join-Path $packageRoot 'enterprise-runtime-bundle\python\python.exe'
  $policyProbe = Join-Path $packageRoot 'scripts\inspect-ssh-group-policy.py'
  $groupHelper = Join-Path $packageRoot 'scripts\LocalSshGroupManagement.ps1'
  if (-not (Test-Path -LiteralPath $manageScript -PathType Leaf) -or
      -not (Test-Path -LiteralPath $pythonExe -PathType Leaf) -or
      -not (Test-Path -LiteralPath $policyProbe -PathType Leaf) -or
      -not (Test-Path -LiteralPath $groupHelper -PathType Leaf)) {
    throw 'The verified package is missing the original SSH access scripts or bundled runtime.'
  }

  $script:stage = 'inbox-openssh-preflight'
  $openSshRoot = Join-Path $env:WINDIR 'System32\OpenSSH'
  $sshdExe = Join-Path $openSshRoot 'sshd.exe'
  $sshExe = Join-Path $openSshRoot 'ssh.exe'
  $sshKeygenExe = Join-Path $openSshRoot 'ssh-keygen.exe'
  $sshKeyscanExe = Join-Path $openSshRoot 'ssh-keyscan.exe'
  foreach ($executable in @($sshdExe, $sshExe, $sshKeygenExe, $sshKeyscanExe)) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
      throw 'The supported inbox OpenSSH executable set is incomplete.'
    }
  }
  $serverCapability = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
  if ($serverCapability.State -ne 'Installed') {
    throw 'The Windows Server 2025 inbox OpenSSH Server capability is not installed on the hosted runner.'
  }
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='sshd'"
  if (-not $service) { throw 'The inbox sshd service is unavailable.' }
  $expectedServicePath = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
  $servicePath = ([string]$service.PathName).Trim()
  if ($servicePath.StartsWith('"') -and $servicePath.EndsWith('"')) {
    $servicePath = $servicePath.Substring(1, $servicePath.Length - 2)
  }
  if ($servicePath -ine $expectedServicePath) {
    throw 'The SCM sshd path is not the exact inbox executable without arguments.'
  }
  if ($service.State -ne 'Stopped') { throw 'The hosted runner sshd service was already running; refusing to disturb it.' }
  if ($service.StartName -notin @('NT SERVICE\SSHD', 'LocalSystem', 'NT AUTHORITY\SYSTEM')) {
    throw 'The inbox sshd service account is outside the supported local service identities.'
  }
  $programDataSsh = Join-Path $env:ProgramData 'ssh'
  Assert-NoReparsePoint -Path $env:ProgramData
  if (-not (Test-Path -LiteralPath $programDataSsh -PathType Container)) {
    [void][IO.Directory]::CreateDirectory($programDataSsh)
  }
  Assert-NoReparsePoint -Path (Join-Path $env:ProgramData 'ssh')
  $script:sshdConfig = Join-Path $programDataSsh 'sshd_config'
  Assert-NoReparsePoint -Path $script:sshdConfig

  $script:stage = 'prepare-controlled-policy'
  $port = Get-FreeLoopbackPort
  $script:testUserName = ('tqa' + [Guid]::NewGuid().ToString('N').Substring(0, 16)).ToLowerInvariant()
  $sshGroupName = 'tradeloom-ssh-users'
  if (Get-LocalGroup -Name $sshGroupName -ErrorAction SilentlyContinue) {
    throw 'The dedicated test group already exists; refusing to reuse it.'
  }
  if (Get-LocalUser -Name $script:testUserName -ErrorAction SilentlyContinue) {
    throw 'The unique test account name is already in use.'
  }

  $authRootName = 'TradeLoomSshHostedQa-' + [Guid]::NewGuid().ToString('N')
  $script:authRoot = Join-Path $env:ProgramData $authRootName
  $authFile = Join-Path $script:authRoot 'authorized_keys'
  $authConfigPath = $authFile.Replace('\', '/')
  $configLines = @(
    "Port $port",
    'ListenAddress 127.0.0.1',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    "AllowGroups $sshGroupName",
    "AuthorizedKeysFile $authConfigPath"
  )
  [IO.File]::WriteAllLines($script:sshdConfig, $configLines, [Text.Encoding]::ASCII)

  $script:stage = 'application-policy-preflight'
  $check = & $manageScript -Action Check
  if (@($check).Count -ne 1 -or -not $check.EligiblePolicy -or
      $check.Reason -cne 'literal_group_declared_not_login_proof' -or
      $check.ConfigState -cne 'read' -or $check.Changed -or $check.LoginVerified) {
    throw 'The original RC21 Check action did not approve the synthetic literal policy.'
  }
  Write-QaStatus 'POLICY_PREFLIGHT_PASS'

  $script:stage = 'create-synthetic-identities-and-key'
  New-LocalGroup -Name $sshGroupName -Description 'Disposable RC21 hosted SSH QA group' | Out-Null
  $plainPassword = 'Qx!2' + [Guid]::NewGuid().ToString('N') + 'z!'
  $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
  try {
    New-LocalUser -Name $script:testUserName -Password $securePassword -PasswordNeverExpires `
      -AccountNeverExpires -Description 'Disposable RC21 hosted SSH QA identity' | Out-Null
  } finally {
    $securePassword.Dispose()
    $plainPassword = $null
  }
  $testUser = Get-LocalUser -Name $script:testUserName
  if (-not $testUser.Enabled) { throw 'The synthetic SSH test identity was not enabled.' }
  $script:testUserSid = [Security.Principal.SecurityIdentifier]$testUser.SID

  $keyStem = Join-Path $script:workRoot 'client-ed25519'
  Invoke-QuietNative -Executable $sshKeygenExe -Arguments @('-q', '-t', 'ed25519', '-N', '""', '-f', $keyStem, '-C', 'rc21-hosted-qa') `
    -FailureMessage 'The synthetic client key could not be generated.'
  $publicKeyPath = "$keyStem.pub"
  if (-not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) { throw 'The synthetic public key file is missing.' }
  Assert-NoReparsePoint -Path $script:authRoot
  $adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $serviceSid = if ($service.StartName -ieq 'NT SERVICE\SSHD') {
    ([Security.Principal.NTAccount]::new('NT SERVICE\SSHD')).Translate([Security.Principal.SecurityIdentifier])
  } else {
    $systemSid
  }
  Set-DirectoryAcl -Path $script:authRoot -Owner $adminSid -Entries @(
    @{ Sid=$adminSid; Rights=[Security.AccessControl.FileSystemRights]::FullControl },
    @{ Sid=$systemSid; Rights=[Security.AccessControl.FileSystemRights]::FullControl },
    @{ Sid=$serviceSid; Rights=[Security.AccessControl.FileSystemRights]::ReadAndExecute },
    @{ Sid=$script:testUserSid; Rights=[Security.AccessControl.FileSystemRights]::ReadAndExecute }
  )
  [IO.File]::WriteAllText($authFile, [IO.File]::ReadAllText($publicKeyPath).Trim() + "`n", [Text.Encoding]::ASCII)
  Set-AuthorizedKeysAcl -Path $authFile -Owner $script:testUserSid -ServiceSid $serviceSid

  $knownHosts = Join-Path $script:workRoot 'known_hosts'
  if ($service.StartMode -eq 'Disabled') {
    Set-Service -Name sshd -StartupType Manual
  }
  $script:stage = 'start-loopback-sshd'
  $script:serviceStartedByQa = $true
  Start-Service -Name sshd
  $serviceController = Get-Service -Name sshd
  $serviceController.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(20))
  $listeners = @()
  $listenDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $listenDeadline)
  if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') {
    throw 'The synthetic sshd listener was not confined to 127.0.0.1.'
  }
  Write-QaStatus 'INBOX_SSHD_LOOPBACK_ONLY'

  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $scanOutput = @(& $sshKeyscanExe -T 5 -t ed25519 -p $port 127.0.0.1 2>$null)
    $scanExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  if ($scanExitCode -ne 0 -or $scanOutput.Count -eq 0) { throw 'The loopback sshd host key could not be pinned.' }
  [IO.File]::WriteAllLines($knownHosts, $scanOutput, [Text.Encoding]::ASCII)

  $script:stage = 'deny-before-grant'
  Invoke-SyntheticSsh -SshExe $sshExe -PrivateKey $keyStem -KnownHosts $knownHosts `
    -UserName $script:testUserName -Port $port -ExpectSuccess $false
  Write-QaStatus 'PRE_GRANT_PUBLIC_KEY_DENIED'

  $script:stage = 'grant-and-authenticate'
  $grant = & $manageScript -Action Grant -UserSid $script:testUserSid.Value -Confirm:$false
  if (-not $grant.Changed -or -not $grant.MembershipPresent -or $grant.LoginVerified) {
    throw 'The original RC21 Grant action did not verify only local group membership.'
  }
  $listed = & $manageScript -Action List
  if (-not (@($listed.Members) -contains $script:testUserSid.Value)) {
    throw 'The original RC21 List action did not reflect the granted local membership.'
  }
  Invoke-SyntheticSsh -SshExe $sshExe -PrivateKey $keyStem -KnownHosts $knownHosts `
    -UserName $script:testUserName -Port $port -ExpectSuccess $true
  Write-QaStatus 'GRANT_AND_PUBLIC_KEY_AUTH_PASS'

  $script:stage = 'revoke-and-recheck'
  $revoke = & $manageScript -Action Revoke -UserSid $script:testUserSid.Value -Confirm:$false
  if (-not $revoke.Changed -or $revoke.MembershipPresent -or $revoke.LoginVerified) {
    throw 'The original RC21 Revoke action did not verify only local group membership.'
  }
  $listed = & $manageScript -Action List
  if (@($listed.Members) -contains $script:testUserSid.Value) {
    throw 'The original RC21 List action still contains the revoked local identity.'
  }
  Invoke-SyntheticSsh -SshExe $sshExe -PrivateKey $keyStem -KnownHosts $knownHosts `
    -UserName $script:testUserName -Port $port -ExpectSuccess $false
  Write-QaStatus 'REVOKE_AND_NEW_CONNECTION_DENIED'
  Write-QaStatus 'EXISTING_SESSION_IMPACT_NOT_TESTED'
  Write-QaStatus 'RC21_HOSTED_SSH_GROUP_QA_PASS'
} catch {
  $script:exitCode = 1
  $failureCode = switch ($script:stage) {
    'runner-guard' { 'runner_guard' }
    'download-package' { 'published_package' }
    'inbox-openssh-preflight' { 'inbox_openssh_prerequisite' }
    'prepare-controlled-policy' { 'controlled_config' }
    'application-policy-preflight' { 'policy_preflight' }
    'create-synthetic-identities-and-key' { 'synthetic_identity_or_key' }
    'start-loopback-sshd' { 'loopback_service' }
    'deny-before-grant' { 'pre_grant_auth' }
    'grant-and-authenticate' { 'grant_or_auth' }
    'revoke-and-recheck' { 'revoke_or_auth' }
    default { 'unexpected' }
  }
  [Console]::Error.WriteLine("RC21_HOSTED_SSH_QA_FAIL code=$failureCode")
} finally {
  try {
    if ($script:serviceStartedByQa) {
      $currentService = Get-Service -Name sshd -ErrorAction SilentlyContinue
      if ($currentService -and $currentService.Status -ne 'Stopped') {
        Stop-Service -Name sshd -Force -ErrorAction Stop
        $currentService = Get-Service -Name sshd
        $currentService.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(20))
      }
    }
  } catch {
    [Console]::Error.WriteLine('QA_CLEANUP_SERVICE_FAILED')
    $script:exitCode = 1
  }
  Write-QaStatus 'HOSTED_RUNNER_VM_RECLAIMS_SYNTHETIC_STATE'
}

exit $script:exitCode
