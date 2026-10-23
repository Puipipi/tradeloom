$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$entryPath = Join-Path $repoRoot 'scripts\launch-local-desktop.ps1'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('tradeloom-daily-entry-test-' + [guid]::NewGuid().ToString('N'))
if (-not $tempRoot.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Synthetic test path escaped the temp directory.' }
$logs = Join-Path $tempRoot 'logs with spaces'
$controller = Join-Path $tempRoot 'fake controller.mjs'
$originalCase = $env:TL_DESKTOP_ENTRY_CASE
$notices = New-Object System.Collections.Generic.List[object]

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

try {
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $fakeControllerSource = @'
if (process.argv[2] !== 'start') {
  process.stderr.write('argument mismatch'); process.exit(8)
}
const mode = process.env.TL_DESKTOP_ENTRY_CASE
if (mode === 'duplicate') { process.stderr.write('此 app home 正在启动。\n'); process.exit(1) }
if (mode === 'managed') { process.stderr.write('此 app home 已由启动器管理；管道存在不表示服务已就绪。\n'); process.exit(1) }
if (mode === 'failure') { process.stderr.write('synthetic-secret-diagnostic\n'); process.exit(7) }
process.exit(0)
'@
  [IO.File]::WriteAllText($controller, $fakeControllerSource, [Text.UTF8Encoding]::new($false))

  . $entryPath
  function Show-TradeLoomDesktopNotice {
    param([string]$Kind, [string]$Message)
    $notices.Add([pscustomobject]@{ Kind = $Kind; Message = $Message })
  }

  $env:TL_DESKTOP_ENTRY_CASE = 'success'
  $code = Invoke-TradeLoomDesktopEntry $controller $node $logs
  Assert-True ($code -eq 0) 'Normal controller exit should map to success.'
  Assert-True ($notices.Count -eq 0) 'Normal controller exit should stay quiet.'
  $logFiles = @(Get-ChildItem -LiteralPath $logs -File)
  Assert-True ($logFiles.Count -eq 2) 'Each invocation should create separate captured stdout and stderr files.'
  Assert-True (($logFiles.Name -join ' ') -match '^desktop-entry-[0-9a-f]{32}\.(stdout|stderr)\.log') 'Attempt logs should use a unique per-invocation name.'

  $env:TL_DESKTOP_ENTRY_CASE = 'duplicate'
  $code = Invoke-TradeLoomDesktopEntry $controller $node $logs
  Assert-True ($code -eq 0) 'Recognized duplicate start should map to quiet success.'
  Assert-True ($notices.Count -eq 1 -and $notices[0].Kind -eq 'Information') 'Recognized duplicate should show one information notice.'
  Assert-True ($notices[0].Message -ceq '织贸助手已在运行或正在启动，请通过任务栏打开已有窗口。') 'Duplicate notice text changed.'

  $env:TL_DESKTOP_ENTRY_CASE = 'managed'
  $code = Invoke-TradeLoomDesktopEntry $controller $node $logs
  Assert-True ($code -eq 0) 'Recognized already-managed exit should map to success.'
  Assert-True ($notices.Count -eq 2 -and $notices[1].Kind -eq 'Information') 'Already-managed should show one information notice.'
  Assert-True ($notices[1].Message -ceq '织贸助手已在运行或正在启动，请通过任务栏打开已有窗口。') 'Already-managed notice text changed.'

  $env:TL_DESKTOP_ENTRY_CASE = 'failure'
  $code = Invoke-TradeLoomDesktopEntry $controller $node $logs
  Assert-True ($code -eq 7) 'A genuine controller failure should preserve its nonzero exit code.'
  Assert-True ($notices.Count -eq 3 -and $notices[2].Kind -eq 'Error') 'A genuine failure should show one error notice.'
  Assert-True ($notices[2].Message -notmatch 'synthetic-secret-diagnostic') 'Raw controller diagnostics must not appear in the notice.'
  Assert-True ($notices[2].Message.Contains($logs)) 'Failure notice should identify the safe log directory.'

  $code = Invoke-TradeLoomDesktopEntry $controller (Join-Path $tempRoot 'missing node.exe') $logs
  Assert-True ($code -eq 1) 'A spawn/configuration failure should return nonzero.'
  Assert-True ($notices.Count -eq 4 -and $notices[3].Kind -eq 'Error') 'A spawn/configuration failure should notify once.'
  Assert-True ($notices[3].Message -notmatch 'missing node|fullyqualified|System.Management|Exception') 'Spawn notice should not reveal raw exception details.'

  'PASS: normal, both recognized duplicate states, genuine failure, missing executable, paths with spaces, safe notices, and per-attempt logs.'
} finally {
  if ($null -eq $originalCase) { Remove-Item Env:TL_DESKTOP_ENTRY_CASE -ErrorAction SilentlyContinue } else { $env:TL_DESKTOP_ENTRY_CASE = $originalCase }
  $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
  $tempBoundary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $safeBasename = [IO.Path]::GetFileName($resolvedTemp).StartsWith('tradeloom-daily-entry-test-', [StringComparison]::Ordinal)
  if ($resolvedTemp.StartsWith($tempBoundary, [StringComparison]::OrdinalIgnoreCase) -and $safeBasename -and (Test-Path -LiteralPath $resolvedTemp)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
  }
}
