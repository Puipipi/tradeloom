param([ValidateSet('start','stop')][string]$Action = 'start')
$node = Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent) 'workspace\runtime\tradeloom-harness\releases\0.2.1-rc.3-tradeloom-desktop-24\apps\desktop\.desktop-build\targets\win-x64\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node (Join-Path $PSScriptRoot 'desktop24.mjs') $Action
exit $LASTEXITCODE
