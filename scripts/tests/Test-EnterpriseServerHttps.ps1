$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'EnterpriseServerHttps.ps1')

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

foreach ($url in @('https://example.org', 'https://example.org/', 'https://example.org/enterprise/', 'https://localhost:29443/enterprise/')) {
  $config = Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl $url
  Assert-True $config.Enabled "Expected HTTPS URL to enable proxy mode: $url"
  Assert-True ($config.Origin -like 'https://*') "Expected HTTPS origin: $url"
}

foreach ($url in @('http://example.org', 'https://user@example.org', 'https://example.org/path', 'https://example.org/enterprise/login', 'https://example.org/?x=1', 'https://example.org/#fragment', ' https://example.org')) {
  $rejected = $false
  try { $null = Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl $url } catch { $rejected = $true }
  Assert-True $rejected "Expected unsafe or unsupported HTTPS URL to be rejected: $url"
}

$empty = Get-EnterpriseHttpsConfiguration -ExternalHttpsUrl ''
Assert-True (-not $empty.Enabled) 'An empty URL must retain local HTTP mode.'
$legacy = [pscustomobject]@{ external_https_url = 'https://example.org/enterprise/' }
Assert-True (-not (Get-EnterpriseHttpsEnabled -Configuration $legacy)) 'Legacy handoff-only configuration must keep HTTP mode.'
$enabled = [pscustomobject]@{ https_enabled = $true; external_https_url = 'https://example.org/enterprise/' }
Assert-True (Get-EnterpriseHttpsEnabled -Configuration $enabled) 'Persisted opt-in must enable HTTPS mode.'

Write-Host 'Enterprise HTTPS URL and legacy-mode checks passed.'
