$script:TLSSHGroupName = 'tradeloom-ssh-users'

function Get-TLSSHPolicy {
  $python = Join-Path $PSScriptRoot '..\enterprise-runtime-bundle\python\python.exe'
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Use the complete Server package with its Python runtime.' }
  $raw = & $python -I -B (Join-Path $PSScriptRoot 'inspect-ssh-group-policy.py')
  if ($LASTEXITCODE -ne 0) { throw 'The fixed read-only policy probe is unavailable.' }
  return ($raw | ConvertFrom-Json)
}

function Test-TLSSHAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TLSSHSidText($Principal) { return [string]$Principal.SID.Value }

function Get-TLSSHState([string]$UserSid) {
  $policy = Get-TLSSHPolicy
  if (-not $policy.eligible -or $policy.group -cne $script:TLSSHGroupName) { throw "Policy is not eligible ($($policy.reason)); ask your Windows administrator to review it. No change was made." }
  if ([string]$policy.fingerprint -notmatch '^[a-f0-9]{64}$') { throw 'The policy snapshot is incomplete; no change is allowed.' }
  $group = Get-LocalGroup -Name $script:TLSSHGroupName -ErrorAction Stop
  $groupSid = Get-TLSSHSidText $group
  if ($group.Name -cne $script:TLSSHGroupName -or $groupSid -notmatch '^(S-1-5-21-\d+-\d+-\d+)-(\d+)$' -or [long]$Matches[2] -lt 1000) { throw 'The fixed group must be an existing dedicated local group, not a built-in group.' }
  $machineSid = $Matches[1]
  $members = @(Get-LocalGroupMember -SID $group.SID -ErrorAction Stop)
  foreach ($member in $members) {
    if ($member.ObjectClass -ne 'User' -or [string]$member.PrincipalSource -ne 'Local' -or (Get-TLSSHSidText $member) -notmatch ('^' + [regex]::Escape($machineSid) + '-\d+$')) { throw 'The fixed group contains unsupported domain or nested principals; use Windows administration directly.' }
  }
  $admins = @(Get-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')) -ErrorAction Stop)
  if (@($admins | Where-Object { $_.ObjectClass -ne 'User' }).Count) { throw 'Nested administrator principals require manual Windows review; this tool does not resolve domain or nested group membership.' }
  if (@($admins | Where-Object { (Get-TLSSHSidText $_) -eq $groupSid }).Count) { throw 'The SSH group is also an administrator; no change is allowed.' }
  foreach ($member in $members) {
    $memberSid = Get-TLSSHSidText $member
    if ([long]($memberSid.Split('-')[-1]) -lt 1000 -or @($admins | Where-Object { (Get-TLSSHSidText $_) -eq $memberSid }).Count) { throw 'The fixed group contains privileged accounts; use Windows administration directly.' }
  }
  $user = $null
  if ($UserSid) {
    $user = Get-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($UserSid)) -ErrorAction Stop
    if ((Get-TLSSHSidText $user) -ne $UserSid -or [string]$user.PrincipalSource -ne 'Local' -or $UserSid -notmatch ('^' + [regex]::Escape($machineSid) + '-(\d+)$') -or [long]$Matches[1] -lt 1000) { throw 'Only an existing ordinary local Windows user SID is accepted.' }
    if (@($admins | Where-Object { (Get-TLSSHSidText $_) -eq $UserSid }).Count) { throw 'Administrator accounts are outside this tool.' }
  }
  $memberSids = @($members | ForEach-Object { Get-TLSSHSidText $_ } | Sort-Object)
  return @{ Policy = $policy; GroupSid = $groupSid; User = $user; Members = $members; MemberSids = $memberSids; Membership = ($memberSids -join ',') }
}

function Invoke-LocalSshGroup {
  [CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
  param(
    [ValidateSet('Check','List','Grant','Revoke')][string]$Action = 'Check',
    [ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$UserSid
  )
  if ([IntPtr]::Size -ne 8 -or $PSVersionTable.PSVersion.Major -lt 5) { throw 'Use 64-bit Windows PowerShell 5.1 or newer.' }
  if ($Action -eq 'Check') {
    $policy = Get-TLSSHPolicy
    return [pscustomobject]@{ Action='Check'; EligiblePolicy=[bool]$policy.eligible; Reason=$policy.reason; ConfigState=$policy.config_state; ConfigReasons=@($policy.config_reasons); Service=$policy.service; Group=$script:TLSSHGroupName; LoginVerified=$false; Changed=$false }
  }
  if (-not (Test-TLSSHAdministrator)) { throw 'Run in an elevated Windows administrator PowerShell. Application roles do not grant OS permissions.' }
  if ($Action -in @('Grant','Revoke') -and -not $UserSid) { throw 'Grant and Revoke require the existing local user SID.' }
  if ($Action -eq 'List' -and $UserSid) { throw 'List does not accept a target user.' }
  $before = Get-TLSSHState $UserSid
  if ($Action -eq 'List') {
    return [pscustomobject]@{ Action='List'; Group=$script:TLSSHGroupName; Members=@($before.MemberSids); LoginVerified=$false; Changed=$false }
  }
  if ($Action -eq 'Grant' -and -not $before.User.Enabled) { throw 'Grant only supports enabled ordinary local users; this tool does not enable accounts.' }
  $present = $before.MemberSids -contains $UserSid
  if (($Action -eq 'Grant' -and $present) -or ($Action -eq 'Revoke' -and -not $present)) {
    return [pscustomobject]@{ Action=$Action; Changed=$false; MembershipPresent=$present; LoginVerified=$false }
  }
  if (-not $PSCmdlet.ShouldProcess("$script:TLSSHGroupName / $UserSid", "$Action existing local group membership (not SSH login verification)")) {
    return [pscustomobject]@{ Action=$Action; Changed=$false; NotApplied=$true; LoginVerified=$false }
  }
  $fresh = Get-TLSSHState $UserSid
  if ($fresh.Policy.fingerprint -ne $before.Policy.fingerprint -or $fresh.GroupSid -ne $before.GroupSid -or $fresh.Membership -ne $before.Membership -or [bool]$fresh.User.Enabled -ne [bool]$before.User.Enabled) { throw 'Policy, group or account membership changed while confirming; recheck before retrying. No change was made.' }
  if ($Action -eq 'Grant') {
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new($fresh.GroupSid)) -Member $UserSid -Confirm:$false -ErrorAction Stop
  } else {
    Remove-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new($fresh.GroupSid)) -Member $UserSid -Confirm:$false -ErrorAction Stop
  }
  $after = Get-TLSSHState $UserSid
  $expected = $Action -eq 'Grant'
  $expectedSids = if ($expected) { @($fresh.MemberSids + $UserSid | Sort-Object -Unique) } else { @($fresh.MemberSids | Where-Object { $_ -ne $UserSid }) }
  if ($after.Policy.fingerprint -ne $fresh.Policy.fingerprint -or $after.GroupSid -ne $fresh.GroupSid -or $after.Membership -ne ($expectedSids -join ',') -or [bool]$after.User.Enabled -ne [bool]$fresh.User.Enabled) { throw 'Post-change verification failed or concurrent policy changed. Inspect the actual local group; no automatic rollback was attempted.' }
  return [pscustomobject]@{ Action=$Action; Changed=$true; MembershipPresent=$expected; LoginVerified=$false }
}
