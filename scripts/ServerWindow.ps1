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
$form.ClientSize = New-Object Drawing.Size(650,540)
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
$mail=New-Button '登录安全设置' 434 185
$admin=New-Object Windows.Forms.GroupBox
$admin.Text='首次管理员（由您自行设置）';$admin.Location=New-Object Drawing.Point(24,247);$admin.Size=New-Object Drawing.Size(600,215);$admin.Enabled=$false;$form.Controls.Add($admin)
function New-Field([string]$Text,[int]$Y,[bool]$Secret) {
  $l=New-Object Windows.Forms.Label;$l.Text=$Text;$l.Location=New-Object Drawing.Point(16,($Y+3));$l.Size=New-Object Drawing.Size(80,26);$admin.Controls.Add($l)
  $box=New-Object Windows.Forms.TextBox;$box.Location=New-Object Drawing.Point(100,$Y);$box.Size=New-Object Drawing.Size(270,28);$box.UseSystemPasswordChar=$Secret;$box.MaxLength=$(if($Secret){4096}else{150});$admin.Controls.Add($box);return $box
}
$username=New-Field '账号' 28 $false
$email=New-Field '绑定邮箱' 65 $false
$email.MaxLength=254
$password=New-Field '密码' 102 $true
$confirmation=New-Field '确认密码' 139 $true
$create=New-Object Windows.Forms.Button;$create.Text='创建首个管理员';$create.Location=New-Object Drawing.Point(400,65);$create.Size=New-Object Drawing.Size(175,40);$admin.Controls.Add($create)
$footer=New-Object Windows.Forms.Label;$footer.Text='正常登录需要邮箱验证码。已有账号可在“登录安全设置”补绑邮箱并配置 SMTP。关闭窗口保留服务。';$footer.Location=New-Object Drawing.Point(24,480);$footer.Size=New-Object Drawing.Size(600,45);$form.Controls.Add($footer)
$open.Enabled=$false
$timer=New-Object Windows.Forms.Timer;$timer.Interval=150
function Begin-Operation([string]$Action,[string]$Payload='') {
  if ($null -ne $script:job) { return }
  $start.Enabled=$refresh.Enabled=$open.Enabled=$admin.Enabled=$mail.Enabled=$false
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
    $mail.Enabled=[bool]($result.ok -and $result.running)
    if($result.has_admin){$username.Clear();$email.Clear();$password.Clear();$confirmation.Clear()}
  } catch {
    $status.ForeColor=[Drawing.Color]::Firebrick;$status.Text='后台未返回有效结果。请确认完整服务器包及当前 Windows 账号权限。'
  } finally {
    $script:job.Process.Dispose();$script:job=$null;$start.Enabled=$refresh.Enabled=$true
  }
})
$start.Add_Click({Begin-Operation 'start'})
$refresh.Add_Click({Begin-Operation 'status'})
$open.Add_Click({Begin-Operation 'open'})
$mail.Add_Click({
  $dialog=New-Object Windows.Forms.Form
  $dialog.Text='登录安全设置 · 本机服务器维护';$dialog.ClientSize=New-Object Drawing.Size(540,530)
  $dialog.StartPosition='CenterParent';$dialog.FormBorderStyle='FixedDialog';$dialog.MaximizeBox=$false
  $tabs=New-Object Windows.Forms.TabControl;$tabs.Dock='Fill';$dialog.Controls.Add($tabs)
  $binding=New-Object Windows.Forms.TabPage;$binding.Text='绑定内部账号邮箱';$tabs.Controls.Add($binding)
  $smtp=New-Object Windows.Forms.TabPage;$smtp.Text='验证码发信 SMTP';$tabs.Controls.Add($smtp)
  function Dialog-Field($Page,[string]$Text,[int]$Y,[bool]$Secret=$false) {
    $label=New-Object Windows.Forms.Label;$label.Text=$Text;$label.Location=New-Object Drawing.Point(20,$Y);$label.Size=New-Object Drawing.Size(130,27);$Page.Controls.Add($label)
    $box=New-Object Windows.Forms.TextBox;$box.Location=New-Object Drawing.Point(155,$Y);$box.Size=New-Object Drawing.Size(330,28);$box.MaxLength=4096;$box.UseSystemPasswordChar=$Secret;$Page.Controls.Add($box);return $box
  }
  $account=Dialog-Field $binding '已有织贸内部账号' 35
  $address=Dialog-Field $binding '绑定邮箱' 85
  $notice=New-Object Windows.Forms.Label;$notice.Text='只补绑邮箱，不改密码、角色、权限或启停。不会创建业务登录会话；旧验证码和登录需要重新验证。';$notice.Location=New-Object Drawing.Point(20,140);$notice.Size=New-Object Drawing.Size(470,85);$binding.Controls.Add($notice)
  $saveEmail=New-Object Windows.Forms.Button;$saveEmail.Text='保存绑定邮箱';$saveEmail.Location=New-Object Drawing.Point(155,240);$saveEmail.Size=New-Object Drawing.Size(200,38);$binding.Controls.Add($saveEmail)
  $hostBox=Dialog-Field $smtp 'SMTP 主机' 25
  $portBox=Dialog-Field $smtp '端口' 72
  $security=New-Object Windows.Forms.ComboBox;$security.DropDownStyle='DropDownList';$null=$security.Items.AddRange(@('ssl','starttls'));$security.SelectedIndex=0;$security.Location=New-Object Drawing.Point(155,119);$security.Size=New-Object Drawing.Size(330,28);$smtp.Controls.Add($security)
  $securityLabel=New-Object Windows.Forms.Label;$securityLabel.Text='加密方式';$securityLabel.Location=New-Object Drawing.Point(20,119);$smtp.Controls.Add($securityLabel)
  $sender=Dialog-Field $smtp '发件邮箱' 166
  $smtpUser=Dialog-Field $smtp 'SMTP 账号' 213
  $smtpPassword=Dialog-Field $smtp 'SMTP 授权密码' 260 $true
  $smtpNotice=New-Object Windows.Forms.Label;$smtpNotice.Text='完整配置由服务器 DPAPI 加密保存，密码不回读。不自动发送测试邮件；不会从网站或样例猜测配置。';$smtpNotice.Location=New-Object Drawing.Point(20,310);$smtpNotice.Size=New-Object Drawing.Size(470,70);$smtp.Controls.Add($smtpNotice)
  $saveSmtp=New-Object Windows.Forms.Button;$saveSmtp.Text='保存发信配置';$saveSmtp.Location=New-Object Drawing.Point(155,400);$saveSmtp.Size=New-Object Drawing.Size(200,38);$smtp.Controls.Add($saveSmtp)
  $saveEmail.Add_Click({
    if(-not $account.Text -or -not $address.Text){[Windows.Forms.MessageBox]::Show($dialog,'请填写已有内部账号及绑定邮箱。') | Out-Null;return}
    $payload=@{operation='bind-email';username=$account.Text;email=$address.Text} | ConvertTo-Json -Compress
    $dialog.Close();Begin-Operation 'mail' $payload;$payload=$null
  })
  $saveSmtp.Add_Click({
    $smtpPort=0
    if(-not [int]::TryParse($portBox.Text,[ref]$smtpPort) -or -not $hostBox.Text -or -not $sender.Text -or -not $smtpUser.Text -or -not $smtpPassword.Text){[Windows.Forms.MessageBox]::Show($dialog,'请填写完整 SMTP 配置和有效端口。') | Out-Null;return}
    $payload=@{operation='smtp';smtp=@{host=$hostBox.Text;port=$smtpPort;security=[string]$security.SelectedItem;from_email=$sender.Text;username=$smtpUser.Text;password=$smtpPassword.Text}} | ConvertTo-Json -Compress
    $smtpPassword.Clear();$dialog.Close();Begin-Operation 'mail' $payload;$payload=$null
  })
  try{$null=$dialog.ShowDialog($form)}finally{$smtpPassword.Clear();$dialog.Dispose()}
})
$create.Add_Click({
  if($password.Text -cne $confirmation.Text){[Windows.Forms.MessageBox]::Show($form,'两次密码不一致。','请检查') | Out-Null;return}
  if([string]::IsNullOrWhiteSpace($username.Text) -or -not $email.Text -or -not $password.Text){[Windows.Forms.MessageBox]::Show($form,'请填写账号、绑定邮箱和密码。') | Out-Null;return}
  $payload=@{username=$username.Text;email=$email.Text;password=$password.Text} | ConvertTo-Json -Compress
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
        $username.Text -or $email.Text -or $password.Text -or $confirmation.Text -or $null -ne $script:job) {
      throw '完整窗体自检失败。'
    }
    exit 0
  } finally { $timer.Dispose(); $form.Dispose() }
}
try { $null=$form.ShowDialog() } finally { $timer.Dispose();$form.Dispose() }
