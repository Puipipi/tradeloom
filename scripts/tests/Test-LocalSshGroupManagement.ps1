$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\LocalSshGroupManagement.ps1')
$script:baseSid = 'S-1-5-21-101-202-303'
$script:userSid = "$script:baseSid-1101"
function Reset-Fixture {
  $script:members = @(); $script:adminMembers = @(); $script:writes = 0; $script:policyCalls = 0
  $script:changeAt = 0; $script:eligible = $true; $script:admin = $true; $script:enabled = $true; $script:source = 'Local'
  $script:memberReads=0; $script:memberChangeAt=0
}
function Get-TLSSHPolicy {
  $script:policyCalls++
  $hash = if ($script:changeAt -and $script:policyCalls -ge $script:changeAt) { 'b' * 64 } else { 'a' * 64 }
  return [pscustomobject]@{ eligible=$script:eligible; group='tradeloom-ssh-users'; fingerprint=$hash; reason='synthetic'; config_state='read'; config_reasons=@('match_not_evaluated'); service=@{status='stopped'} }
}
function Test-TLSSHAdministrator { return $script:admin }
function Get-LocalGroup { param($Name,$ErrorAction)
  if ($Name -ne 'tradeloom-ssh-users') { throw 'Unexpected group lookup' }
  return [pscustomobject]@{ Name=$Name; SID=[Security.Principal.SecurityIdentifier]::new("$script:baseSid-2101") }
}
function Get-LocalUser { param($SID,$ErrorAction)
  return [pscustomobject]@{ SID=$SID; Enabled=$script:enabled; PrincipalSource=$script:source }
}
function Get-LocalGroupMember { param($SID,$ErrorAction)
  if ($SID.Value -ne 'S-1-5-32-544') {
    $script:memberReads++
    if ($script:memberChangeAt -eq $script:memberReads) { $script:members += "$script:baseSid-1102" }
  }
  $values = if ($SID.Value -eq 'S-1-5-32-544') { $script:adminMembers } else { $script:members }
  foreach ($value in $values) { [pscustomobject]@{ SID=[Security.Principal.SecurityIdentifier]::new($value); PrincipalSource='Local'; ObjectClass='User' } }
}
function Add-LocalGroupMember { param($SID,$Member,$Confirm,$ErrorAction)
  if ($SID.Value -ne "$script:baseSid-2101" -or $Member -ne $script:userSid) { throw 'Unexpected mutation identity' }
  $script:writes++; $script:members += $Member
}
function Remove-LocalGroupMember { param($SID,$Member,$Confirm,$ErrorAction)
  if ($SID.Value -ne "$script:baseSid-2101" -or $Member -ne $script:userSid) { throw 'Unexpected mutation identity' }
  $script:writes++; $script:members = @($script:members | Where-Object { $_ -ne $Member })
}
function Assert-True($condition,[string]$message) { if (-not $condition) { throw $message } }
function Assert-Rejected([scriptblock]$operation) { $denied=$false; try { & $operation | Out-Null } catch { $denied=$true }; Assert-True $denied 'Expected refusal' }

Reset-Fixture
$check = Invoke-LocalSshGroup -Action Check
Assert-True ($check.ConfigState -eq 'read' -and $check.ConfigReasons -contains 'match_not_evaluated' -and -not $check.Changed -and -not $check.LoginVerified -and $script:writes -eq 0) 'Check diagnostics were missing or performed a mutation'
Write-Output 'READ_ONLY_CHECK_DIAGNOSTICS=PASS'

$script:policyCalls = 0
$result = Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false
Assert-True ($result.Changed -and $script:writes -eq 1 -and -not $result.LoginVerified) 'Grant did not verify membership'
Assert-True (-not (Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false).Changed) 'Grant was not idempotent'
Assert-True ((Invoke-LocalSshGroup -Action List).Members.Count -eq 1) 'List did not read actual synthetic membership'
Assert-True ((Invoke-LocalSshGroup -Action Revoke -UserSid $script:userSid -Confirm:$false).Changed) 'Revoke failed'
Assert-True (-not (Invoke-LocalSshGroup -Action Revoke -UserSid $script:userSid -Confirm:$false).Changed) 'Revoke was not idempotent'
Write-Output 'SYNTHETIC_GRANT_REVOKE_LIST_IDEMPOTENT=PASS'

Reset-Fixture
$null = Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -WhatIf
Assert-True ($script:writes -eq 0) 'WhatIf mutated membership'
$script:admin=$false
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Reset-Fixture; $script:eligible=$false
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Reset-Fixture; $script:adminMembers=@($script:userSid)
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Reset-Fixture; $script:source='ActiveDirectory'
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Reset-Fixture; $script:enabled=$false
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Write-Output 'SYNTHETIC_WHATIF_AND_PRIVILEGE_REFUSALS=PASS'

Reset-Fixture; $script:changeAt=2
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Assert-True ($script:writes -eq 0) 'Concurrent pre-change policy was ignored'
Reset-Fixture; $script:changeAt=3
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Assert-True ($script:writes -eq 1) 'Post-change fixture did not reach verification'
Reset-Fixture; $script:memberChangeAt=2
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Assert-True ($script:writes -eq 0) 'Concurrent pre-change membership was ignored'
Reset-Fixture; $script:memberChangeAt=3
Assert-Rejected { Invoke-LocalSshGroup -Action Grant -UserSid $script:userSid -Confirm:$false }
Assert-True ($script:writes -eq 1) 'Concurrent post-change membership was not observed'
Write-Output 'SYNTHETIC_CONCURRENT_POLICY_CHANGES=PASS'
