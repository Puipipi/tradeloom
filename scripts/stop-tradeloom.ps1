param([string]$DataRoot)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
$entry = Join-Path $repoRoot 'apps\tradeloom-launcher\cli.mjs'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '未找到织贸助手运行所需的 Node.js。' }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '未找到织贸助手停止入口。' }
$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = $node
$processInfo.WorkingDirectory = $repoRoot
$processInfo.UseShellExecute = $false
$processInfo.Arguments = '"' + $entry + '" stop'
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
  $processInfo.EnvironmentVariables.Remove('TRADELOOM_DATA_ROOT')
} else {
  if ($DataRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') { throw 'DataRoot 必须是绝对 Windows 路径。' }
  $processInfo.EnvironmentVariables['TRADELOOM_DATA_ROOT'] = [IO.Path]::GetFullPath($DataRoot)
}
$process = [System.Diagnostics.Process]::Start($processInfo)
$process.WaitForExit()
exit $process.ExitCode
