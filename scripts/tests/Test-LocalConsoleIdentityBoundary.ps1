$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'EnterpriseServerHttps.ps1')
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'LocalServerConsoleRuntime.ps1')
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('tl-console-identity-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  @{ runtime_root = $scratch; app_root = $scratch; http_port = 27429 } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $scratch 'server-config.json')
  '12345' | Set-Content -LiteralPath (Join-Path $scratch 'django.pid')
  # Synthetic Windows adapters: no real process, account enumeration, issuer,
  # service secrets, network listener or Python command is accessed by this test.
  function Get-Acl { param($LiteralPath) [pscustomobject]@{ Access = @() } }
  function Get-CimInstance { param($ClassName, $Filter) [pscustomobject]@{
    ExecutablePath = Join-Path $scratch 'python\python.exe'
    CommandLine = ((Join-Path $scratch 'manage.py') + ' runserver 127.0.0.1:27429')
  } }
  function Invoke-CimMethod { param($InputObject, $MethodName) [pscustomobject]@{ ReturnValue = 0; Sid = 'S-1-5-21-111-222-333-9999' } }
  function Get-NetTCPConnection { throw 'Listener access must not be reached after identity refusal.' }
  foreach ($action in @('open', 'enable')) {
    $message = ''
    try { Invoke-LocalServerConsoleCommand -DataRoot $scratch -Action $action } catch { $message = $_.Exception.Message }
    if ($message -notlike '*尚不支持技术员自己的另一 Windows 账户*' -or $message -notlike '*未签发授权*') { throw 'Different identity must fail before any issuer or listener access.' }
  }
  Write-Output 'PASS: open/enable reject synthetic different Windows SID before listener, secrets or issuer access.'
} finally {
  if ([IO.Path]::GetFullPath($scratch).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
