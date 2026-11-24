[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
  [ValidateSet('Check','List','Grant','Revoke')][string]$Action = 'Check',
  [ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$UserSid
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\Manage-SshAccess.ps1') @PSBoundParameters
