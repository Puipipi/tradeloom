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
$script:failureCode = 'runner_guard'

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
                               [Security.Principal.SecurityIdentifier]$ServiceSid,
                               [Security.Principal.SecurityIdentifier]$AdminSid,
                               [Security.Principal.SecurityIdentifier]$SystemSid,
                               [string]$IcaclsExe) {
  $acl = [IO.File]::GetAccessControl($Path)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($AdminSid, $SystemSid, $ServiceSid, $Owner)) {
    $acl.PurgeAccessRules($sid)
  }
  $desired = @(
    @{ Sid=$AdminSid; Rights=[Security.AccessControl.FileSystemRights]::FullControl },
    @{ Sid=$SystemSid; Rights=[Security.AccessControl.FileSystemRights]::FullControl }
  )
  if ($ServiceSid.Value -cne $SystemSid.Value) {
    $desired += @{ Sid=$ServiceSid; Rights=[Security.AccessControl.FileSystemRights]::Read }
  }
  $desired += @(
    @{ Sid=$Owner; Rights=[Security.AccessControl.FileSystemRights]::Read }
  )
  foreach ($entry in $desired) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $entry.Sid, $entry.Rights, [Security.AccessControl.AccessControlType]::Allow)
    $null = $acl.AddAccessRule($rule)
  }
  # Preserve administrator WRITE_DAC in the DACL before changing the owner.
  [IO.File]::SetAccessControl($Path, $acl)
  Invoke-QuietNative -Executable $IcaclsExe -Arguments @($Path, '/setowner', ('*' + $Owner.Value)) `
    -FailureMessage 'The synthetic authorized_keys owner could not be set.'

  $verified = [IO.File]::GetAccessControl($Path)
  $actualOwner = $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $expected = [Collections.Generic.Dictionary[string, Security.AccessControl.FileSystemRights]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $desired) {
    $expectedRule = [Security.AccessControl.FileSystemAccessRule]::new(
      $entry.Sid, $entry.Rights, [Security.AccessControl.AccessControlType]::Allow)
    $expected.Add($entry.Sid.Value, $expectedRule.FileSystemRights)
  }
  if ($actualOwner -cne $Owner.Value -or -not $verified.AreAccessRulesProtected -or
      $rules.Count -ne $expected.Count) { throw 'The synthetic authorized_keys owner or DACL did not match.' }
  foreach ($rule in $rules) {
    $sidValue = $rule.IdentityReference.Value
    if (-not $expected.ContainsKey($sidValue) -or $rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne $expected[$sidValue]) {
      throw 'The synthetic authorized_keys DACL did not match.'
    }
  }
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
  $script:failureCode = 'runner_guard'
  if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
      $env:GITHUB_REPOSITORY -ine 'Puipipi/tradeloom' -or
      $env:GITHUB_REF -cne 'refs/heads/qa/enterprise-ssh-rc21-hosted') {
    throw 'This QA script is restricted to its dedicated GitHub-hosted repository branch.'
  }
  Write-QaStatus 'HOSTED_RUNNER_GUARD_PASS'

  $script:stage = 'inbox-openssh-preflight'
  $script:failureCode = 'server_capability_query_failed'
  $serverCapabilityName = 'OpenSSH.Server~~~~0.0.1.0'
  $serverCapability = Get-WindowsCapability -Online -Name $serverCapabilityName -ErrorAction Stop
  if ($serverCapability.State -ne 'Installed') {
    $script:failureCode = 'server_capability_install_failed'
    $installResult = Add-WindowsCapability -Online -Name $serverCapabilityName -ErrorAction Stop
    if ($installResult.RestartNeeded) {
      $script:failureCode = 'server_capability_reboot_required'
      throw 'The inbox OpenSSH Server capability requires a runner reboot.'
    }
    $script:failureCode = 'server_capability_install_failed'
    $serverCapability = Get-WindowsCapability -Online -Name $serverCapabilityName -ErrorAction Stop
    if ($serverCapability.State -ne 'Installed') { throw 'The inbox OpenSSH Server capability did not become installed.' }
  }
  Write-QaStatus 'INBOX_SERVER_CAPABILITY_READY'

  $openSshRoot = Join-Path $env:WINDIR 'System32\OpenSSH'
  $sshdExe = Join-Path $openSshRoot 'sshd.exe'
  $sshExe = Join-Path $openSshRoot 'ssh.exe'
  $sshKeygenExe = Join-Path $openSshRoot 'ssh-keygen.exe'
  $missingClientFiles = @(@($sshExe, $sshKeygenExe) | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
  if ($missingClientFiles.Count -gt 0) {
    $script:failureCode = 'client_capability_query_failed'
    $clientCapabilityName = 'OpenSSH.Client~~~~0.0.1.0'
    $clientCapability = Get-WindowsCapability -Online -Name $clientCapabilityName -ErrorAction Stop
    if ($clientCapability.State -ne 'Installed') {
      $script:failureCode = 'client_capability_install_failed'
      $installResult = Add-WindowsCapability -Online -Name $clientCapabilityName -ErrorAction Stop
      if ($installResult.RestartNeeded) {
        $script:failureCode = 'client_capability_reboot_required'
        throw 'The inbox OpenSSH Client capability requires a runner reboot.'
      }
      $script:failureCode = 'client_capability_install_failed'
      $clientCapability = Get-WindowsCapability -Online -Name $clientCapabilityName -ErrorAction Stop
      if ($clientCapability.State -ne 'Installed') { throw 'The inbox OpenSSH Client capability did not become installed.' }
    }
  }
  Write-QaStatus 'INBOX_CLIENT_CAPABILITY_READY'

  $script:failureCode = 'no_sshd_exe'
  if (-not (Test-Path -LiteralPath $sshdExe -PathType Leaf)) { throw 'The inbox sshd executable is missing.' }
  $script:failureCode = 'no_ssh_exe'
  if (-not (Test-Path -LiteralPath $sshExe -PathType Leaf)) { throw 'The inbox ssh executable is missing.' }
  $script:failureCode = 'no_ssh_keygen_exe'
  if (-not (Test-Path -LiteralPath $sshKeygenExe -PathType Leaf)) { throw 'The inbox ssh-keygen executable is missing.' }
  Write-QaStatus 'INBOX_EXECUTABLES_READY'

  $script:failureCode = 'service_query_failed'
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='sshd'" -ErrorAction Stop
  if (-not $service) {
    $script:failureCode = 'service_missing'
    throw 'The inbox sshd service is missing.'
  }
  $expectedServicePath = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'
  $servicePath = ([string]$service.PathName).Trim()
  if ($servicePath.StartsWith('"') -and $servicePath.EndsWith('"')) {
    $servicePath = $servicePath.Substring(1, $servicePath.Length - 2)
  }
  $script:failureCode = 'mismatched_scm_path'
  if ($servicePath -ine $expectedServicePath) {
    throw 'The SCM sshd path is not the exact inbox executable without arguments.'
  }
  Write-QaStatus 'SSHD_SCM_PATH_VERIFIED'
  $script:failureCode = 'unsupported_service_account'
  if ($service.StartName -notin @('NT SERVICE\SSHD', 'LocalSystem', 'NT AUTHORITY\SYSTEM')) {
    throw 'The inbox sshd service account is outside the supported local service identities.'
  }
  $script:failureCode = 'unsupported_service_state'
  if ($service.State -notin @('Running', 'Stopped')) { throw 'The inbox sshd service has an unsupported state.' }
  Write-QaStatus "SSHD_SERVICE_STATE_ACCEPTED state=$($service.State.ToLowerInvariant())"

  $script:failureCode = 'programdata_ssh_unavailable'
  Assert-NoReparsePoint -Path $env:ProgramData
  $programDataSsh = Join-Path $env:ProgramData 'ssh'
  if (-not (Test-Path -LiteralPath $programDataSsh -PathType Container)) {
    [void][IO.Directory]::CreateDirectory($programDataSsh)
  }
  Assert-NoReparsePoint -Path $programDataSsh
  $script:sshdConfig = Join-Path $programDataSsh 'sshd_config'
  Assert-NoReparsePoint -Path $script:sshdConfig
  Write-QaStatus 'SSHD_DEFAULT_CONFIG_ROOT_READY'
  Write-QaStatus 'INBOX_PREFLIGHT_PASS'

  $script:failureCode = 'runner_temp_unavailable'
  if (-not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'The hosted runner temporary directory is unavailable.'
  }
  $script:failureCode = 'runner_temp_reparse'
  Assert-NoReparsePoint -Path $env:RUNNER_TEMP
  $script:failureCode = 'runner_temp_noncanonical'
  $runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
  if ($runnerTemp -ine [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')) {
    throw 'The hosted runner temporary path did not resolve to its canonical location.'
  }
  $script:failureCode = 'runner_temp_create_failed'
  $script:workRoot = Join-Path $runnerTemp ('tradeloom-ssh-qa-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($script:workRoot)
  Assert-NoReparsePoint -Path $script:workRoot
  if ((Split-Path -Parent (Resolve-Path -LiteralPath $script:workRoot).Path) -ine $runnerTemp) {
    throw 'The QA workspace escaped the hosted runner temporary directory.'
  }

  $script:stage = 'download-package'
  $script:failureCode = 'package_download_failed'
  $releaseUrl = 'https://github.com/Puipipi/tradeloom/releases/download/v6.18.0-rc.21/TradeLoom-Server-Windows-x64-v6.18.0-rc.21-preview.zip'
  $expectedHash = '7cc765a4f8c0e2f0b9f6efd1490a6c8e89fffece867dceb3027e8b40093e3c62'
  $archive = Join-Path $script:workRoot 'TradeLoom-Server-Windows-x64-v6.18.0-rc.21-preview.zip'
  Invoke-WebRequest -Uri $releaseUrl -OutFile $archive -TimeoutSec 180 -UseBasicParsing
  $script:failureCode = 'package_hash_failed'
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -cne $expectedHash) { throw 'The published RC21 package SHA-256 did not match.' }
  Write-QaStatus 'PACKAGE_SHA256_VERIFIED'

  $archiveRoot = Join-Path $script:workRoot 'package'
  $script:failureCode = 'package_extract_failed'
  [void][IO.Directory]::CreateDirectory($archiveRoot)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $allowedFiles = @(
      'Server/Manage-SshAccess.ps1',
      'Server/scripts/Manage-SshAccess.ps1',
      'Server/scripts/LocalSshGroupManagement.ps1',
      'Server/scripts/inspect-ssh-group-policy.py',
      'Server/enterprise_portal/__init__.py',
      'Server/enterprise_portal/operations_ssh.py',
      'Server/enterprise_portal/ssh_group_policy.py'
    )
    $requiredFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($file in $allowedFiles) { [void]$requiredFiles.Add($file) }
    $script:failureCode = 'package_entries_missing'
    foreach ($entry in $zip.Entries) {
      $entryName = $entry.FullName.Replace('\', '/')
      if (-not ($entryName.StartsWith('Server/enterprise-runtime-bundle/python/', [StringComparison]::Ordinal) -or
                $requiredFiles.Contains($entryName))) { continue }
      if ($entryName.Split('/') -contains '..') { throw 'The verified package contains an unsafe path.' }
      $relative = $entryName.Substring('Server/'.Length).Replace('/', [IO.Path]::DirectorySeparatorChar)
      $target = Join-Path (Join-Path $archiveRoot 'Server') $relative
      $targetFull = [IO.Path]::GetFullPath($target)
      $serverFull = [IO.Path]::GetFullPath((Join-Path $archiveRoot 'Server') + [IO.Path]::DirectorySeparatorChar)
      if (-not $targetFull.StartsWith($serverFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'The verified package entry escaped its extraction root.' }
      if ($entryName.EndsWith('/')) {
        [void][IO.Directory]::CreateDirectory($targetFull)
        continue
      }
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($targetFull))
      $inputStream = $entry.Open()
      try {
        $outputStream = [IO.File]::Create($targetFull)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
      } finally { $inputStream.Dispose() }
      if ($requiredFiles.Contains($entryName)) { [void]$requiredFiles.Remove($entryName) }
    }
    if ($requiredFiles.Count -gt 0) { throw 'The verified RC21 archive is missing required original files.' }
  } finally { $zip.Dispose() }
  Write-QaStatus 'PACKAGE_REQUIRED_FILES_EXTRACTED'
  $packageRoot = Join-Path $archiveRoot 'Server'
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

  $script:stage = 'prepare-controlled-policy'
  $script:failureCode = 'controlled_config'
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
  $script:failureCode = 'service_stop_failed'
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='sshd'" -ErrorAction Stop
  if (-not $service -or $service.PathName.Trim().Trim('"') -ine $expectedServicePath -or
      $service.StartName -notin @('NT SERVICE\SSHD', 'LocalSystem', 'NT AUTHORITY\SYSTEM')) {
    $script:failureCode = 'inbox_service_changed'
    throw 'The inbox sshd service identity changed after preflight.'
  }
  if ($service.State -eq 'Running') {
    Stop-Service -Name sshd -ErrorAction Stop
    $serviceController = Get-Service -Name sshd -ErrorAction Stop
    $serviceController.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(20))
  } elseif ($service.State -ne 'Stopped') {
    $script:failureCode = 'unsupported_service_state'
    throw 'The inbox sshd service entered an unsupported state.'
  }
  Write-QaStatus 'INBOX_SSHD_STOPPED_FOR_SYNTHETIC_CONFIG'
  $script:failureCode = 'controlled_config'
  [IO.File]::WriteAllLines($script:sshdConfig, $configLines, [Text.Encoding]::ASCII)

  $script:stage = 'application-policy-preflight'
  $script:failureCode = 'policy_preflight'
  $check = & $manageScript -Action Check
  if (@($check).Count -ne 1 -or -not $check.EligiblePolicy -or
      $check.Reason -cne 'literal_group_declared_not_login_proof' -or
      $check.ConfigState -cne 'read' -or $check.Changed -or $check.LoginVerified) {
    throw 'The original RC21 Check action did not approve the synthetic literal policy.'
  }
  Write-QaStatus 'POLICY_PREFLIGHT_PASS'

  $script:stage = 'create-synthetic-identities-and-key'
  $script:failureCode = 'local_group_create_failed'
  New-LocalGroup -Name $sshGroupName -Description 'Disposable RC21 hosted SSH QA group' | Out-Null
  $plainPassword = 'Qx!2' + [Guid]::NewGuid().ToString('N') + 'z!'
  $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
  try {
    $script:failureCode = 'local_user_create_failed'
    New-LocalUser -Name $script:testUserName -Password $securePassword -PasswordNeverExpires `
      -AccountNeverExpires -Description 'Disposable RC21 hosted SSH QA identity' | Out-Null
  } finally {
    $securePassword.Dispose()
    $plainPassword = $null
  }
  $script:failureCode = 'local_user_read_failed'
  $testUser = Get-LocalUser -Name $script:testUserName
  if (-not $testUser.Enabled) { throw 'The synthetic SSH test identity was not enabled.' }
  $script:testUserSid = [Security.Principal.SecurityIdentifier]$testUser.SID

  $keyStem = Join-Path $script:workRoot 'client-ed25519'
  $script:failureCode = 'client_keygen_failed'
  Invoke-QuietNative -Executable $sshKeygenExe -Arguments @('-q', '-t', 'ed25519', '-N', '""', '-f', $keyStem, '-C', 'rc21-hosted-qa') `
    -FailureMessage 'The synthetic client key could not be generated.'
  $publicKeyPath = "$keyStem.pub"
  $script:failureCode = 'client_public_key_missing'
  if (-not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) { throw 'The synthetic public key file is missing.' }
  $script:failureCode = 'authorized_keys_directory_acl_failed'
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
  $script:failureCode = 'authorized_keys_write_failed'
  [IO.File]::WriteAllText($authFile, [IO.File]::ReadAllText($publicKeyPath).Trim() + "`n", [Text.Encoding]::ASCII)
  $script:failureCode = 'authorized_keys_file_acl_failed'
  $icaclsExe = Join-Path $env:WINDIR 'System32\icacls.exe'
  Set-AuthorizedKeysAcl -Path $authFile -Owner $script:testUserSid -ServiceSid $serviceSid `
    -AdminSid $adminSid -SystemSid $systemSid -IcaclsExe $icaclsExe

  $knownHosts = Join-Path $script:workRoot 'known_hosts'
  if ($service.StartMode -eq 'Disabled') {
    Set-Service -Name sshd -StartupType Manual
  }
  $script:stage = 'start-loopback-sshd'
  $script:failureCode = 'loopback_service'
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

  $hostKeyLines = @()
  foreach ($hostKeyName in @('ssh_host_ed25519_key.pub', 'ssh_host_ecdsa_key.pub', 'ssh_host_rsa_key.pub')) {
    $hostKeyPath = Join-Path $programDataSsh $hostKeyName
    if (-not (Test-Path -LiteralPath $hostKeyPath -PathType Leaf)) { continue }
    $parts = ([IO.File]::ReadAllText($hostKeyPath).Trim() -split '\s+')
    if ($parts.Count -ge 2 -and $parts[0] -match '^ssh-|^ecdsa-') {
      $hostKeyLines += "[127.0.0.1]:$port $($parts[0]) $($parts[1])"
    }
  }
  if ($hostKeyLines.Count -eq 0) { throw 'The inbox sshd generated no supported host public key.' }
  [IO.File]::WriteAllLines($knownHosts, $hostKeyLines, [Text.Encoding]::ASCII)

  $script:stage = 'deny-before-grant'
  $script:failureCode = 'pre_grant_auth'
  Invoke-SyntheticSsh -SshExe $sshExe -PrivateKey $keyStem -KnownHosts $knownHosts `
    -UserName $script:testUserName -Port $port -ExpectSuccess $false
  Write-QaStatus 'PRE_GRANT_PUBLIC_KEY_DENIED'

  $script:stage = 'grant-and-authenticate'
  $script:failureCode = 'grant_or_auth'
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
  $script:failureCode = 'revoke_or_auth'
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
  $errorType = $_.Exception.GetType().Name -replace '[^A-Za-z0-9_.-]', '_'
  $errorType = $errorType.Substring(0, [Math]::Min(64, $errorType.Length))
  $errorId = ([string]$_.FullyQualifiedErrorId -replace '[^A-Za-z0-9_.-]', '_')
  $errorId = $errorId.Substring(0, [Math]::Min(80, $errorId.Length))
  [Console]::Error.WriteLine("RC21_HOSTED_SSH_QA_FAIL code=$($script:failureCode) type=$errorType id=$errorId")
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
