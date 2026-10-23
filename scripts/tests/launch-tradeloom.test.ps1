$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$wrapperSource = Join-Path $repoRoot 'scripts\launch-tradeloom.ps1'
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$node = $nodeCommand.Source
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('tradeloom-launch-wrapper-test-' + [guid]::NewGuid().ToString('N'))
$syntheticRepo = Join-Path $tempRoot 'repo'
$syntheticScripts = Join-Path $syntheticRepo 'scripts'
$syntheticEntryDir = Join-Path $syntheticRepo 'apps\tradeloom-launcher'
$captureFile = Join-Path $tempRoot 'captured-argv.json'
$driverFile = Join-Path $tempRoot 'driver.ps1'
$driverStdout = Join-Path $tempRoot 'driver.stdout.txt'
$driverStderr = Join-Path $tempRoot 'driver.stderr.txt'
$fakeEntry = Join-Path $syntheticEntryDir 'cli.mjs'
$syntheticWrapper = Join-Path $syntheticScripts 'launch-tradeloom.ps1'
$originalPassword = $env:TRADELOOM_DB_PASSWORD
$originalCapture = $env:TL_CAPTURE_ARGS

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

function Invoke-SyntheticWrapper([string]$runtimeExpression, [bool]$includeRuntime, [bool]$positionalErp = $false) {
  Remove-Item -LiteralPath $captureFile -Force -ErrorAction SilentlyContinue
  $wrapperQuoted = "'" + $syntheticWrapper.Replace("'", "''") + "'"
  if ($positionalErp) { $runtimeLine = '& ' + $wrapperQuoted + ' desktop ''C:\Synthetic DataRoot'' ''C:\Synthetic ERP\config.json''' }
  elseif ($includeRuntime) { $runtimeLine = '$runtime = ' + $runtimeExpression + '; & ' + $wrapperQuoted + ' -Mode desktop -DataRoot ''C:\Synthetic DataRoot'' -Runtime $runtime' }
  else { $runtimeLine = '& ' + $wrapperQuoted + ' -Mode desktop -DataRoot ''C:\Synthetic DataRoot''' }
  $template = @'
$ErrorActionPreference = 'Stop'
function Get-NetAdapter { param([switch]$Physical) [pscustomobject]@{ Name='Synthetic Wi-Fi'; InterfaceDescription='Synthetic adapter'; InterfaceType=71; PhysicalMediaType='802.11'; MediaType='802.11'; Status='Up'; HardwareInterface=$true; ifIndex=71 } }
function Get-NetIPAddress { param([int]$InterfaceIndex, [string]$AddressFamily, [string]$ErrorAction) [pscustomobject]@{ AddressState='Preferred'; IPAddress='192.168.77.8' } }
$env:TL_CAPTURE_ARGS = '__CAPTURE_FILE__'
$env:TRADELOOM_DB_PASSWORD = 'synthetic-only-password'
__RUNTIME_LINE__
'@
  $driver = $template.Replace('__CAPTURE_FILE__', $captureFile.Replace("'", "''")).Replace('__RUNTIME_LINE__', $runtimeLine)
  Set-Content -LiteralPath $driverFile -Value $driver -Encoding utf8
  $powerShellExe = Join-Path $PSHOME 'powershell.exe'
  $driver = Start-Process -FilePath $powerShellExe -ArgumentList @('-NoProfile', '-File', $driverFile) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $driverStdout -RedirectStandardError $driverStderr
  $script:lastDriverStderr = if (Test-Path -LiteralPath $driverStderr) { Get-Content -LiteralPath $driverStderr -Raw } else { '' }
  return $driver.ExitCode
}

try {
  New-Item -ItemType Directory -Path $syntheticScripts,$syntheticEntryDir -Force | Out-Null
  Copy-Item -LiteralPath $wrapperSource -Destination $syntheticWrapper
  @'
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.TL_CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)))
'@ | Set-Content -LiteralPath $fakeEntry -Encoding utf8

  $env:TRADELOOM_DB_PASSWORD = 'synthetic-only-password'
  $env:TL_CAPTURE_ARGS = $captureFile
  $passExit = Invoke-SyntheticWrapper "'C:\Synthetic Runtime\desktop 8'" $true
  Assert-True ($passExit -eq 0) ('Explicit runtime wrapper call did not exit 0: ' + $script:lastDriverStderr)
  $capturedArgs = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $captureFile -Raw)
  $runtimeIndex = [Array]::IndexOf($capturedArgs, '--runtime')
  Assert-True ($runtimeIndex -ge 0 -and $capturedArgs[$runtimeIndex + 1] -ceq 'C:\Synthetic Runtime\desktop 8') ('Runtime path with spaces was not forwarded as one argument: ' + ($capturedArgs -join ' | '))
  Assert-True ($capturedArgs -contains '--candidates' -and $capturedArgs -contains '--host') 'Wrapper stopped forwarding synthetic network selection arguments.'

  $defaultExit = Invoke-SyntheticWrapper '' $false
  Assert-True ($defaultExit -eq 0) ('Omitted runtime wrapper call did not exit 0: ' + $script:lastDriverStderr)
  $defaultArgs = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $captureFile -Raw)
  Assert-True (-not ($defaultArgs -contains '--runtime')) 'Omitted runtime changed the existing default-candidate behavior.'

  $positionalExit = Invoke-SyntheticWrapper '' $false $true
  Assert-True ($positionalExit -eq 0) ('Existing third positional ERP configuration binding failed: ' + $script:lastDriverStderr)
  $positionalArgs = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $captureFile -Raw)
  $erpIndex = [Array]::IndexOf($positionalArgs, '--erpnext-config-file')
  Assert-True ($erpIndex -ge 0 -and $positionalArgs[$erpIndex + 1] -ceq 'C:\Synthetic ERP\config.json') 'Existing third positional ERP argument was not forwarded.'

  foreach ($badExpression in @("'relative\runtime'", "''", "'C:\Synthetic`"quoted'", "('C:\Synthetic' + [char]13 + [char]10 + 'Runtime')", "'C:drive-relative'", "'\root-relative'") ) {
    $invalidExit = Invoke-SyntheticWrapper $badExpression $true
    Assert-True ($invalidExit -ne 0) "Invalid runtime was accepted: $badExpression"
    Assert-True (-not (Test-Path -LiteralPath $captureFile)) "Invalid runtime launched the synthetic CLI: $badExpression"
  }

  Write-Output 'PASS: explicit runtime with spaces is forwarded as one argument.'
  Write-Output 'PASS: omitted runtime preserves the existing default-candidate behavior.'
  Write-Output 'PASS: the existing third positional ERP configuration argument remains compatible.'
  Write-Output 'PASS: relative, empty, quoted and newline runtime values fail before child launch.'
  exit 0
} finally {
  $env:TRADELOOM_DB_PASSWORD = $originalPassword
  $env:TL_CAPTURE_ARGS = $originalCapture
  $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTempRoot).StartsWith('tradeloom-launch-wrapper-test-', [StringComparison]::Ordinal)) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
