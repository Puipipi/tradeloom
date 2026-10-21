# 下载排版/印刷需要的开源中文字体到 assets/fonts/
# 用 Noto Sans SC / Noto Serif SC（OFL 1.1，可商用，ReportLab 只吃 TTF）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\fetch_fonts.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $root 'assets\fonts'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$fonts = [ordered]@{
    'NotoSansSC-VF.ttf'  = 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf'
    'NotoSerifSC-VF.ttf' = 'https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf'
}

foreach ($name in $fonts.Keys) {
    $out = Join-Path $dir $name
    if (Test-Path $out) {
        Write-Host "[skip] $name 已存在"
        continue
    }
    Write-Host "[get ] $name"
    Invoke-WebRequest -Uri $fonts[$name] -OutFile $out -UseBasicParsing -TimeoutSec 300 `
        -Headers @{ 'User-Agent' = 'Mozilla/5.0' }
    $mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
    Write-Host "[ ok ] $name  $mb MB"
}

Write-Host "`n完成。字体目录：$dir"
Write-Host "验证：.venv\Scripts\python.exe scripts\check_env.py"
