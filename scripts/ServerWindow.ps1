param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [string]$RuntimeSource = '',
  [int]$Port = 27417,
  [int]$PostgresPort = 56427,
  [switch]$Probe
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$root = [IO.Path]::GetFullPath($DataRoot)
$script:job = $null
$script:adminReady = $false
function Quote-Argument([string]$Value) {
  # CommandLineToArgvW quoting; no shell expansion or -Command is used.
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
$form = New-Object Windows.Forms.Form
$form.Text = '织贸工作台 · 企业服务器'
$form.ClientSize = New-Object Drawing.Size(650,480)
$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox=$false
$form.StartPosition='CenterScreen'
$form.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
$form.BackColor=[Drawing.Color]::FromArgb(245,247,250)
$title=New-Object Windows.Forms.Label
$title.Text='企业服务器';$title.Font=New-Object Drawing.Font('Microsoft YaHei UI',18,[Drawing.FontStyle]::Bold)
$title.Location=New-Object Drawing.Point(24,20);$title.AutoSize=$true;$form.Controls.Add($title)
$directory=New-Object Windows.Forms.Label
$directory.Text='数据目录：'+$root;$directory.Location=New-Object Drawing.Point(24,68);$directory.Size=New-Object Drawing.Size(600,45);$directory.AutoEllipsis=$true;$form.Controls.Add($directory)
$status=New-Object Windows.Forms.Label
$status.Text='正在检查本机安装…';$status.Location=New-Object Drawing.Point(24,117);$status.Size=New-Object Drawing.Size(600,64);$form.Controls.Add($status)
function New-Button([string]$Text,[int]$X,[int]$Width) {
  $b=New-Object Windows.Forms.Button;$b.Text=$Text;$b.Location=New-Object Drawing.Point($X,189);$b.Size=New-Object Drawing.Size($Width,36);$form.Controls.Add($b);return $b
}
$start=New-Button '启动服务' 24 110
$refresh=New-Button '刷新状态' 144 110
$open=New-Button '打开管理控制台' 264 160
$admin=New-Object Windows.Forms.GroupBox
$admin.Text='首次管理员（由您自行设置）';$admin.Location=New-Object Drawing.Point(24,247);$admin.Size=New-Object Drawing.Size(600,170);$admin.Enabled=$false;$form.Controls.Add($admin)
function New-Field([string]$Text,[int]$Y,[bool]$Secret) {
  $l=New-Object Windows.Forms.Label;$l.Text=$Text;$l.Location=New-Object Drawing.Point(16,($Y+3));$l.Size=New-Object Drawing.Size(80,26);$admin.Controls.Add($l)
  $box=New-Object Windows.Forms.TextBox;$box.Location=New-Object Drawing.Point(100,$Y);$box.Size=New-Object Drawing.Size(270,28);$box.UseSystemPasswordChar=$Secret;$box.MaxLength=$(if($Secret){4096}else{150});$admin.Controls.Add($box);return $box
}
$username=New-Field '账号' 28 $false
$password=New-Field '密码' 65 $true
$confirmation=New-Field '确认密码' 102 $true
$create=New-Object Windows.Forms.Button;$create.Text='创建首个管理员';$create.Location=New-Object Drawing.Point(400,65);$create.Size=New-Object Drawing.Size(175,40);$admin.Controls.Add($create)
$footer=New-Object Windows.Forms.Label;$footer.Text='关闭窗口会保留正在运行的服务。账号密码不会由启动器保存。';$footer.Location=New-Object Drawing.Point(24,435);$footer.Size=New-Object Drawing.Size(600,30);$form.Controls.Add($footer)
$open.Enabled=$false
$timer=New-Object Windows.Forms.Timer;$timer.Interval=150
function Begin-Operation([string]$Action,[string]$Payload='') {
  if ($null -ne $script:job) { return }
  $start.Enabled=$refresh.Enabled=$open.Enabled=$admin.Enabled=$false
  $status.ForeColor=[Drawing.Color]::FromArgb(40,55,80)
  $status.Text=$(if($Action -eq 'start'){'正在准备服务，首次安装可能需要几分钟…'}else{'正在检查，请稍候…'})
  try {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File ' + (Quote-Argument (Join-Path $PSScriptRoot 'ServerGuiBackend.ps1')) + ' -Action ' + $Action + ' -DataRoot ' + (Quote-Argument $root) + ' -RuntimeSource ' + (Quote-Argument $RuntimeSource) + ' -Port ' + $Port + ' -PostgresPort ' + $PostgresPort
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WindowStyle='Hidden'
    $info.RedirectStandardInput=$info.RedirectStandardOutput=$info.RedirectStandardError=$true
    $info.StandardOutputEncoding=New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding=New-Object Text.UTF8Encoding($false)
    $p=New-Object Diagnostics.Process;$p.StartInfo=$info;$null=$p.Start()
    $outTask=$p.StandardOutput.ReadLineAsync();$errTask=$p.StandardError.ReadToEndAsync()
    if ($Payload) {
      $bytes=[Text.Encoding]::UTF8.GetBytes($Payload+[char]10)
      $p.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$p.StandardInput.BaseStream.Flush();[Array]::Clear($bytes,0,$bytes.Length)
    }
    $p.StandardInput.Close()
    $script:job=@{Process=$p;Output=$outTask;Error=$errTask}
    $timer.Start()
  } catch {
    $status.ForeColor=[Drawing.Color]::Firebrick;$status.Text='无法启动后台任务。请确认脚本完整且使用安装服务器的 Windows 账号运行。'
    $start.Enabled=$refresh.Enabled=$true
  }
}
$timer.Add_Tick({
  if ($null -eq $script:job -or -not $script:job.Process.HasExited) { return }
  $timer.Stop()
  try {
    $output=$script:job.Output.GetAwaiter().GetResult()
    # Long-lived PostgreSQL descendants can retain inherited pipe handles.
    # The backend protocol is exactly one JSON line; never await descendant EOF.
    $result=$output.Trim() | ConvertFrom-Json
    $status.Text=[string]$result.message
    if($result.ok){$status.ForeColor=[Drawing.Color]::FromArgb(25,100,65)}else{$status.ForeColor=[Drawing.Color]::Firebrick}
    $admin.Enabled=[bool]($result.ok -and $result.running -and -not $result.has_admin)
    $open.Enabled=[bool]($result.ok -and $result.running -and $result.has_admin)
    if($result.has_admin){$username.Clear();$password.Clear();$confirmation.Clear()}
  } catch {
    $status.ForeColor=[Drawing.Color]::Firebrick;$status.Text='后台未返回有效结果。请确认完整服务器包及当前 Windows 账号权限。'
  } finally {
    $script:job.Process.Dispose();$script:job=$null;$start.Enabled=$refresh.Enabled=$true
  }
})
$start.Add_Click({Begin-Operation 'start'})
$refresh.Add_Click({Begin-Operation 'status'})
$open.Add_Click({Begin-Operation 'open'})
$create.Add_Click({
  if($password.Text -cne $confirmation.Text){[Windows.Forms.MessageBox]::Show($form,'两次密码不一致。','请检查') | Out-Null;return}
  if([string]::IsNullOrWhiteSpace($username.Text) -or -not $password.Text){[Windows.Forms.MessageBox]::Show($form,'请填写账号和密码。') | Out-Null;return}
  $payload=@{username=$username.Text;password=$password.Text} | ConvertTo-Json -Compress
  $password.Clear();$confirmation.Clear()
  Begin-Operation 'create' $payload
  $payload=$null
})
$form.Add_Shown({Begin-Operation 'status'})
$form.Add_FormClosing({param($sender,$eventArgs)
  if($null -ne $script:job){$eventArgs.Cancel=$true;[Windows.Forms.MessageBox]::Show($form,'正在处理，请等待结果后关闭窗口。服务不会因关闭窗口而停止。') | Out-Null}
})
if ($Probe) {
  try {
    if ($form.Text -ne '织贸工作台 · 企业服务器' -or $form.Controls.Count -lt 8 -or
        $start.Text -ne '启动服务' -or $open.Text -ne '打开管理控制台' -or
        -not $password.UseSystemPasswordChar -or -not $confirmation.UseSystemPasswordChar -or
        $username.Text -or $password.Text -or $confirmation.Text -or $null -ne $script:job) {
      throw '完整窗体自检失败。'
    }
    exit 0
  } finally { $timer.Dispose(); $form.Dispose() }
}
try { $null=$form.ShowDialog() } finally { $timer.Dispose();$form.Dispose() }
