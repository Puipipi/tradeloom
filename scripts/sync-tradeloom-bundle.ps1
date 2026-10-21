param(
  [ValidateSet('desktop', 'web')][string]$Mode = 'web',
  [string]$DataRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$entry = Join-Path $repoRoot 'apps\tradeloom-launcher\cli.mjs'
if (-not $node -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '未找到织贸助手运行所需的 Node.js。' }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '未找到织贸助手启动器文件。' }
if (-not [string]::IsNullOrWhiteSpace($DataRoot)) {
  if ($DataRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') { throw 'DataRoot 必须是绝对 Windows 路径。' }
  $DataRoot = [IO.Path]::GetFullPath($DataRoot)
}

$hadDataRoot = Test-Path Env:TRADELOOM_DATA_ROOT
$oldDataRoot = $env:TRADELOOM_DATA_ROOT
try {
  if ([string]::IsNullOrWhiteSpace($DataRoot)) { Remove-Item Env:TRADELOOM_DATA_ROOT -ErrorAction SilentlyContinue }
  else { $env:TRADELOOM_DATA_ROOT = $DataRoot }
  & $node $entry sync-dev-bundle --mode $Mode
  $syncExitCode = $LASTEXITCODE
} finally {
  if ($hadDataRoot) { $env:TRADELOOM_DATA_ROOT = $oldDataRoot }
  else { Remove-Item Env:TRADELOOM_DATA_ROOT -ErrorAction SilentlyContinue }
}
exit $syncExitCode
