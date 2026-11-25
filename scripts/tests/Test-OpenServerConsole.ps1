$ErrorActionPreference = 'Stop'
$launcher = Join-Path (Split-Path $PSScriptRoot -Parent) 'Open-ServerConsole.ps1'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('tl-console-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
function Check-Url($Configuration, [string]$Expected) {
  $Configuration | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $scratch 'server-config.json')
  $actual = & $launcher -DataRoot $scratch -PrintUrlOnly
  if ($actual -cne $Expected) { throw "Unexpected console address: $actual" }
}
try {
  Check-Url @{ http_port = 27417 } 'http://127.0.0.1:27417/enterprise/console/'
  Check-Url @{ http_port = 27417; external_https_url = 'https://old.example/enterprise/' } 'http://127.0.0.1:27417/enterprise/console/'
  Check-Url @{ https_enabled = $true; external_https_url = 'https://server.example:443/enterprise/' } 'https://server.example/enterprise/console/'
  foreach ($config in @(
    @{ http_port = 80 },
    @{ http_port = '27417/evil' },
    @{ https_enabled = $true; external_https_url = 'http://server.example' },
    @{ https_enabled = $true; external_https_url = 'https://server.example/?token=secret' },
    @{ https_enabled = $true; external_https_url = '' }
  )) {
    $config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $scratch 'server-config.json')
    $rejected = $false
    try { $null = & $launcher -DataRoot $scratch -PrintUrlOnly } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid installation configuration was accepted.' }
  }
  Write-Host 'Console launcher checks passed (3 valid, 5 rejected; no browser or service started).'
} finally {
  # The absolute directory is created above solely for this test.
  if ([IO.Path]::GetFullPath($scratch).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $scratch -Recurse -Force
  }
}
