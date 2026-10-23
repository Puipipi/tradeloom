param(
  [string]$ControllerPath,
  [string]$NodeExecutable,
  [string]$LogDirectory
)

$ErrorActionPreference = 'Stop'

function Show-TradeLoomDesktopNotice {
  param(
    [ValidateSet('Information', 'Error')][string]$Kind,
    [string]$Message
  )

  Add-Type -AssemblyName System.Windows.Forms
  $icon = if ($Kind -eq 'Information') { [System.Windows.Forms.MessageBoxIcon]::Information } else { [System.Windows.Forms.MessageBoxIcon]::Error }
  [void][System.Windows.Forms.MessageBox]::Show($Message, '织贸助手', [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}

function ConvertTo-TradeLoomQuotedArgument {
  param([string]$Value)
  '"' + $Value.Replace('"', '\\"') + '"'
}

function Invoke-TradeLoomDesktopEntry {
  param(
    [string]$ControllerPath,
    [string]$NodeExecutable,
    [string]$LogDirectory
  )

  $stdoutPath = $null
  $stderrPath = $null
  try {
    foreach ($value in @($ControllerPath, $NodeExecutable, $LogDirectory)) {
      if ([string]::IsNullOrWhiteSpace($value) -or $value -match '["\r\n]' -or $value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
        throw '入口参数必须是无引号、无换行的绝对路径。'
      }
    }
    $ControllerPath = [IO.Path]::GetFullPath($ControllerPath)
    $NodeExecutable = [IO.Path]::GetFullPath($NodeExecutable)
    $LogDirectory = [IO.Path]::GetFullPath($LogDirectory)
    if (-not (Test-Path -LiteralPath $ControllerPath -PathType Leaf)) { throw '未找到本地启动控制器。' }
    if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw '未找到 Node.js。' }
    if (-not (Test-Path -LiteralPath $LogDirectory -PathType Container)) { throw '本地日志目录不存在。' }

    $attempt = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $LogDirectory ('desktop-entry-' + $attempt + '.stdout.log')
    $stderrPath = Join-Path $LogDirectory ('desktop-entry-' + $attempt + '.stderr.log')
    $arguments = (ConvertTo-TradeLoomQuotedArgument $ControllerPath) + ' start'
    $process = Start-Process -FilePath $NodeExecutable -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $ControllerPath) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    if ($process.ExitCode -eq 0) { return 0 }

    $stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath) } else { '' }
    $duplicateMessages = @(
      '此 app home 正在启动。',
      '此 app home 已由启动器管理；管道存在不表示服务已就绪。'
    )
    if ($process.ExitCode -eq 1 -and $duplicateMessages -ccontains $stderr.TrimEnd([char[]]@(13, 10))) {
      Show-TradeLoomDesktopNotice -Kind Information -Message '织贸助手已在运行或正在启动，请通过任务栏打开已有窗口。'
      return 0
    }

    Show-TradeLoomDesktopNotice -Kind Error -Message ('织贸助手未能启动。请检查本地日志：' + $stdoutPath + '、' + $stderrPath)
    return [int]$process.ExitCode
  } catch {
    $safeLog = if ($stdoutPath) { $stdoutPath } else { $LogDirectory }
    Show-TradeLoomDesktopNotice -Kind Error -Message ('织贸助手未能启动。请检查本地入口配置。日志位置：' + $safeLog)
    return 1
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  exit (Invoke-TradeLoomDesktopEntry -ControllerPath $ControllerPath -NodeExecutable $NodeExecutable -LogDirectory $LogDirectory)
}
