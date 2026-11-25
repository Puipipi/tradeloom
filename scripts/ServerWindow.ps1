param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'TradeLoomEnterpriseServer'),
  [string]$RuntimeSource = '',
  [int]$Port = 27417,
  [int]$PostgresPort = 56427,
  [switch]$Probe,
  [switch]$VisibilityProbe,
  [ValidateSet('','Light','Dark','HighContrast')][string]$VisualProbeTheme = '',
  [string]$VisualProbeDirectory = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
if(($VisualProbeTheme -or $VisualProbeDirectory) -and -not $Probe){throw 'Visual capture requires -Probe.'}
function Get-ServerTheme {
  $mode='Light'
  if([Windows.Forms.SystemInformation]::HighContrast){$mode='HighContrast'}else{
    $preference=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction SilentlyContinue
    if($null -ne $preference -and $preference.AppsUseLightTheme -eq 0){$mode='Dark'}
  }
  if($Probe -and $VisualProbeTheme){$mode=$VisualProbeTheme}
  if($mode -eq 'HighContrast'){
    return @{Mode=$mode;Background=[Drawing.SystemColors]::Control;Panel=[Drawing.SystemColors]::Control;Hover=[Drawing.SystemColors]::ControlLight;Border=[Drawing.SystemColors]::WindowText;Text=[Drawing.SystemColors]::ControlText;Dim=[Drawing.SystemColors]::ControlText;Accent=[Drawing.SystemColors]::Highlight;OnAccent=[Drawing.SystemColors]::HighlightText;Input=[Drawing.SystemColors]::Window}
  }
  $values=if($mode -eq 'Dark'){@('#0b0d12','#131722','#1a2030','#232a3a','#e6e8ee','#a5aec2','#4f8cff','#0b0d12')}else{@('#f5f7fa','#ffffff','#eef1f6','#d7dde7','#1f2430','#667085','#2563eb','#ffffff')}
  $theme=@{Mode=$mode};$keys=@('Background','Panel','Hover','Border','Text','Dim','Accent','OnAccent')
  for($index=0;$index -lt $keys.Count;$index++){$theme[$keys[$index]]=[Drawing.ColorTranslator]::FromHtml($values[$index])}
  $theme.Input=$theme.Background;return $theme
}
$script:theme=Get-ServerTheme
$script:bodyFont=New-Object Drawing.Font('Segoe UI',10.5)
$script:headingFont=New-Object Drawing.Font('Segoe UI Semibold',18)
function Set-ServerTheme($Control) {
  $Control.Font=$script:bodyFont;$Control.ForeColor=$script:theme.Text
  if($Control -is [Windows.Forms.Form]){$Control.BackColor=$script:theme.Background}
  elseif($Control -is [Windows.Forms.Button]){
    if($script:theme.Mode -eq 'HighContrast'){$Control.FlatStyle='Standard';$Control.UseVisualStyleBackColor=$true}
    else{
      $Control.UseVisualStyleBackColor=$false;$Control.FlatStyle='Flat';$Control.FlatAppearance.BorderSize=1
      $Control.FlatAppearance.BorderColor=$script:theme.Border;$Control.BackColor=$script:theme.Panel
      $Control.FlatAppearance.MouseOverBackColor=$script:theme.Hover;$Control.FlatAppearance.MouseDownBackColor=$script:theme.Hover
      if($Control.Name -eq 'primary-action'){$Control.BackColor=$script:theme.Accent;$Control.ForeColor=$script:theme.OnAccent;$Control.FlatAppearance.BorderColor=$script:theme.Accent;$Control.FlatAppearance.MouseOverBackColor=$script:theme.Accent;$Control.FlatAppearance.MouseDownBackColor=$script:theme.Accent}
      $Control.Add_Paint({param($sender,$eventArgs)
        if(-not $sender.Enabled){
          $brush=New-Object Drawing.SolidBrush($script:theme.Panel);$pen=New-Object Drawing.Pen($script:theme.Border)
          try{$eventArgs.Graphics.FillRectangle($brush,$sender.ClientRectangle);$eventArgs.Graphics.DrawRectangle($pen,0,0,($sender.Width-1),($sender.Height-1))}finally{$brush.Dispose();$pen.Dispose()}
          [Windows.Forms.TextRenderer]::DrawText($eventArgs.Graphics,$sender.Text,$sender.Font,$sender.ClientRectangle,$script:theme.Dim,([Windows.Forms.TextFormatFlags]::HorizontalCenter -bor [Windows.Forms.TextFormatFlags]::VerticalCenter))
        }
      })
    }
  }
  elseif($Control -is [Windows.Forms.TextBox]){$Control.BackColor=$script:theme.Input;$Control.BorderStyle='FixedSingle'}
  elseif($Control -is [Windows.Forms.LinkLabel]){
    $Control.BackColor=$Control.Parent.BackColor
    $Control.LinkColor=if($script:theme.Mode -eq 'HighContrast'){[Drawing.SystemColors]::HotTrack}else{$script:theme.Accent}
    $Control.ActiveLinkColor=$Control.LinkColor
  }
  elseif($Control -is [Windows.Forms.ComboBox]){
    $Control.BackColor=$script:theme.Input
    if($script:theme.Mode -ne 'HighContrast'){
      $Control.FlatStyle='Flat';$Control.DrawMode='OwnerDrawFixed'
      $Control.Add_DrawItem({param($sender,$eventArgs)
        if($eventArgs.Index -lt 0){return}
        $brush=New-Object Drawing.SolidBrush($script:theme.Input)
        try{$eventArgs.Graphics.FillRectangle($brush,$eventArgs.Bounds)}finally{$brush.Dispose()}
        [Windows.Forms.TextRenderer]::DrawText($eventArgs.Graphics,[string]$sender.Items[$eventArgs.Index],$sender.Font,$eventArgs.Bounds,$script:theme.Text,([Windows.Forms.TextFormatFlags]::Left -bor [Windows.Forms.TextFormatFlags]::VerticalCenter))
        $eventArgs.DrawFocusRectangle()
      })
    }
  }
  elseif($Control -is [Windows.Forms.TabControl]){
    $Control.BackColor=$script:theme.Panel
    if($script:theme.Mode -ne 'HighContrast'){
      $Control.DrawMode='OwnerDrawFixed'
      $Control.Add_DrawItem({param($sender,$eventArgs)
        $lastTab=$sender.GetTabRect($sender.TabCount-1);$strip=New-Object Drawing.SolidBrush($script:theme.Background);try{$eventArgs.Graphics.FillRectangle($strip,$lastTab.Right,0,($sender.Width-$lastTab.Right),($eventArgs.Bounds.Height+2))}finally{$strip.Dispose()}
        $background=if($eventArgs.Index -eq $sender.SelectedIndex){$script:theme.Panel}else{$script:theme.Background}
        $brush=New-Object Drawing.SolidBrush($background)
        try{$eventArgs.Graphics.FillRectangle($brush,$eventArgs.Bounds)}finally{$brush.Dispose()}
        [Windows.Forms.TextRenderer]::DrawText($eventArgs.Graphics,$sender.TabPages[$eventArgs.Index].Text,$script:bodyFont,$eventArgs.Bounds,$script:theme.Text,([Windows.Forms.TextFormatFlags]::HorizontalCenter -bor [Windows.Forms.TextFormatFlags]::VerticalCenter))
        if(($eventArgs.State -band [Windows.Forms.DrawItemState]::Focus) -ne 0){[Windows.Forms.ControlPaint]::DrawFocusRectangle($eventArgs.Graphics,$eventArgs.Bounds,$script:theme.Text,$background)}
      })
    }
  }
  elseif($Control -is [Windows.Forms.GroupBox] -or $Control -is [Windows.Forms.TabPage]){$Control.BackColor=$script:theme.Panel}
  else{$Control.BackColor=$Control.Parent.BackColor}
  if($Control.Name -eq 'muted'){$Control.ForeColor=$script:theme.Dim}
  if($Control.Name -eq 'page-title'){$Control.Font=$script:headingFont}
  if($Control -is [Windows.Forms.Label] -and $script:theme.Mode -ne 'HighContrast'){
    $Control.Add_Paint({param($sender,$eventArgs)
      if(-not $sender.Enabled){$brush=New-Object Drawing.SolidBrush($sender.BackColor);try{$eventArgs.Graphics.FillRectangle($brush,$sender.ClientRectangle)}finally{$brush.Dispose()};[Windows.Forms.TextRenderer]::DrawText($eventArgs.Graphics,$sender.Text,$sender.Font,$sender.ClientRectangle,$script:theme.Dim,[Windows.Forms.TextFormatFlags]::Left)}
    })
  }
  if($Control -is [Windows.Forms.GroupBox] -and $script:theme.Mode -ne 'HighContrast'){
    $Control.Add_Paint({param($sender,$eventArgs)
      if(-not $sender.Enabled){
        $size=[Windows.Forms.TextRenderer]::MeasureText($sender.Text,$sender.Font)
        $caption=New-Object Drawing.Rectangle(6,0,($size.Width+4),$size.Height)
        $brush=New-Object Drawing.SolidBrush($sender.BackColor)
        try{$eventArgs.Graphics.FillRectangle($brush,$caption)}finally{$brush.Dispose()}
        [Windows.Forms.TextRenderer]::DrawText($eventArgs.Graphics,$sender.Text,$sender.Font,$caption,$script:theme.Dim,[Windows.Forms.TextFormatFlags]::Left)
      }
    })
  }
  foreach($child in $Control.Controls){Set-ServerTheme $child}
}
function Save-VisualProbe($Window,[string]$Name) {
  if(-not $VisualProbeDirectory){return}
  $target=[IO.Path]::GetFullPath($VisualProbeDirectory)
  if(-not(Test-Path -LiteralPath $target -PathType Container)){throw 'Create an isolated visual output directory first.'}
  $wasVisible=$Window.Visible
  if(-not $wasVisible){$Window.Show();[Windows.Forms.Application]::DoEvents()}
  $bitmap=New-Object Drawing.Bitmap($Window.Width,$Window.Height)
  try{
    $Window.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$Window.Width,$Window.Height)))
    $origin=$Window.PointToScreen([Drawing.Point]::Empty)
    $client=New-Object Drawing.Rectangle(($origin.X-$Window.Left),($origin.Y-$Window.Top),$Window.ClientSize.Width,$Window.ClientSize.Height)
    $cropped=$bitmap.Clone($client,$bitmap.PixelFormat)
    try{$cropped.Save((Join-Path $target ($Name+'.png')),[Drawing.Imaging.ImageFormat]::Png)}finally{$cropped.Dispose()}
  }finally{$bitmap.Dispose();if(-not $wasVisible){$Window.Hide()}}
}
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
$title.Name='page-title';$title.Text='企业服务器'
$title.Location=New-Object Drawing.Point(24,20);$title.AutoSize=$true;$form.Controls.Add($title)
$directory=New-Object Windows.Forms.Label
$directory.Text='数据目录：'+$root;$directory.Location=New-Object Drawing.Point(24,68);$directory.Size=New-Object Drawing.Size(600,45);$directory.AutoEllipsis=$true;$form.Controls.Add($directory)
$directory.Name='muted'
$status=New-Object Windows.Forms.Label
$status.Text='正在检查本机安装…';$status.Location=New-Object Drawing.Point(24,117);$status.Size=New-Object Drawing.Size(600,64);$form.Controls.Add($status)
$status.Padding=New-Object Windows.Forms.Padding(12,8,12,8);$status.TextAlign='MiddleLeft'
$status.Add_Paint({param($sender,$eventArgs) $pen=New-Object Drawing.Pen($script:theme.Border);try{$eventArgs.Graphics.DrawRectangle($pen,0,0,($sender.Width-1),($sender.Height-1))}finally{$pen.Dispose()}})
function New-Button([string]$Text,[int]$X,[int]$Width) {
  $b=New-Object Windows.Forms.Button;$b.Text=$Text;$b.Location=New-Object Drawing.Point($X,189);$b.Size=New-Object Drawing.Size($Width,36);$form.Controls.Add($b);return $b
}
$start=New-Button '启动服务' 24 110
$start.Name='primary-action'
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
$create.Name='primary-action'
$footer=New-Object Windows.Forms.Label;$footer.Text='正常登录需要邮箱验证码。已有账号可在“登录安全设置”补绑邮箱并配置 SMTP。关闭窗口保留服务。';$footer.Location=New-Object Drawing.Point(24,480);$footer.Size=New-Object Drawing.Size(600,45);$form.Controls.Add($footer)
$footer.Name='muted'
$manage=New-Object Windows.Forms.Button;$manage.Text='管理助手';$manage.Location=New-Object Drawing.Point(434,24);$manage.Size=New-Object Drawing.Size(185,36);$form.Controls.Add($manage)
$managementDialog=New-Object Windows.Forms.Form;$managementDialog.Text='管理助手 · 企业服务器';$managementDialog.ClientSize=New-Object Drawing.Size(624,260);$managementDialog.StartPosition='CenterParent';$managementDialog.FormBorderStyle='FixedDialog';$managementDialog.MaximizeBox=$false;$managementDialog.Font=$form.Font
$assistantPanel=New-Object Windows.Forms.GroupBox
$assistantPanel.Text='管理助手';$assistantPanel.Location=New-Object Drawing.Point(12,12);$assistantPanel.Size=New-Object Drawing.Size(600,235);$managementDialog.Controls.Add($assistantPanel)
$assistantHint=New-Object Windows.Forms.Label;$assistantHint.Text='可说“检查服务状态”“启动服务”“停止服务”“重启服务器”，或点击下方按钮。';$assistantHint.Location=New-Object Drawing.Point(14,25);$assistantHint.Size=New-Object Drawing.Size(570,42);$assistantPanel.Controls.Add($assistantHint)
$assistantHint.Name='muted'
$assistantInput=New-Object Windows.Forms.TextBox;$assistantInput.Location=New-Object Drawing.Point(14,72);$assistantInput.Size=New-Object Drawing.Size(465,28);$assistantInput.MaxLength=100;$assistantPanel.Controls.Add($assistantInput)
$assistantSend=New-Object Windows.Forms.Button;$assistantSend.Text='执行';$assistantSend.Location=New-Object Drawing.Point(490,70);$assistantSend.Size=New-Object Drawing.Size(90,30);$assistantPanel.Controls.Add($assistantSend)
$assistantSend.Name='primary-action'
$assistantResult=New-Object Windows.Forms.Label;$assistantResult.Text='只管理本安装的服务状态与启停。停止和重启需要再次确认。';$assistantResult.Location=New-Object Drawing.Point(14,154);$assistantResult.Size=New-Object Drawing.Size(570,68);$assistantPanel.Controls.Add($assistantResult)
function Resolve-ManagementIntent([string]$Text) {
  $text=$Text.Trim().TrimEnd('。','！','!','？','?').Replace(' ','')
  switch -Regex ($text) {
    '^(请)?(检查|查看|查询|刷新)?(当前)?(服务器|服务)?(状态|是否正常|运行情况)$|^服务正常吗$' {return 'status'}
    '^(请)?(启动|开启|打开)(服务器|服务)$' {return 'start'}
    '^(请)?(停止|关闭|停掉)(服务器|服务)$' {return 'stop'}
    '^(请)?(重启|重新启动)(服务器|服务)$' {return 'restart'}
    default {return ''}
  }
}
function Request-ManagementAction([string]$Intent,[scriptblock]$Confirm) {
  if($Intent -notin @('status','start','stop','restart')) {$assistantResult.Text='暂不支持这句话。请选择状态、启动、停止或重启；不能执行任意命令。';return}
  if($null -ne $script:job){return}
  $payload=''
  if($Intent -in @('stop','restart')) {
    if(-not (& $Confirm $Intent)) {$assistantResult.Text='已取消，未向服务派发任何操作。';return}
    $payload='{"confirmed":true}'
  }
  Begin-Operation ('manage-'+$Intent) $payload
}
$script:confirmManagement={param($intent)
  $verb=if($intent -eq 'stop'){'停止'}else{'重启'}
  return [Windows.Forms.MessageBox]::Show($managementDialog,('确认'+$verb+'本安装的网页服务及数据库？正在使用服务的用户会暂时断开。'),'确认'+$verb,[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Warning,[Windows.Forms.MessageBoxDefaultButton]::Button2) -eq [Windows.Forms.DialogResult]::Yes
}
$manage.Add_Click({Begin-Operation 'manage-status';$null=$managementDialog.ShowDialog($form)})
$managementDialog.Add_FormClosing({param($sender,$eventArgs) if($null -ne $script:job){$eventArgs.Cancel=$true}})
$assistantSend.Add_Click({Request-ManagementAction (Resolve-ManagementIntent $assistantInput.Text) $script:confirmManagement})
$assistantInput.Add_KeyDown({param($sender,$eventArgs) if($eventArgs.KeyCode -eq 'Enter'){$eventArgs.SuppressKeyPress=$true;$assistantSend.PerformClick()}})
$x=14
foreach($definition in @(@('查看状态','status'),@('启动服务','start'),@('停止服务','stop'),@('重启服务','restart'))) {
  $button=New-Object Windows.Forms.Button;$button.Text=$definition[0];$button.Tag=$definition[1];$button.Location=New-Object Drawing.Point($x,111);$button.Size=New-Object Drawing.Size(132,31);$assistantPanel.Controls.Add($button)
  $button.Add_Click({param($sender,$eventArgs) Request-ManagementAction ([string]$sender.Tag) $script:confirmManagement});$x+=144
}
$open.Enabled=$false
$script:securityResult=$null
$script:createAccount=''
$script:bindingAccount=''
$timer=New-Object Windows.Forms.Timer;$timer.Interval=150
function Begin-Operation([string]$Action,[string]$Payload='') {
  if ($null -ne $script:job) { return }
  $start.Enabled=$refresh.Enabled=$open.Enabled=$admin.Enabled=$mail.Enabled=$assistantPanel.Enabled=$false
  $status.ForeColor=$script:theme.Text
  $status.Text=$(switch($Action){'manage-stop'{'正在停止本安装服务，请稍候…'} 'manage-restart'{'正在重启本安装服务并检查健康，请稍候…'} {$_ -in @('start','manage-start')}{'正在准备服务，首次安装可能需要几分钟…'} default{'正在检查，请稍候…'}})
  if($Action.StartsWith('manage-')){$assistantResult.Text=$status.Text}
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
    $script:job=@{Process=$p;Output=$outTask;Error=$errTask;Action=$Action}
    $timer.Start()
  } catch {
    $status.ForeColor=$script:theme.Text;$status.Text='无法启动后台任务。请确认使用完整服务器包，或联系服务器维护人员。';$assistantResult.Text=$status.Text
    $start.Enabled=$refresh.Enabled=$assistantPanel.Enabled=$true
    if($script:securityResult){& $script:securityResult @{ok=$false;message=$status.Text} $Action}
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
    $action=$script:job.Action
    $status.Text=[string]$result.message
    if($script:job.Action.StartsWith('manage-')){$assistantResult.Text=[string]$result.message}
    if($result.ok){$status.ForeColor=$script:theme.Accent}else{$status.ForeColor=$script:theme.Text}
    if($script:job.Action.StartsWith('manage-')) {
      $admin.Enabled=[bool]($result.ok -and $result.running -and -not $script:adminReady);$open.Enabled=[bool]($result.ok -and $result.running -and $script:adminReady);$mail.Enabled=[bool]($result.ok -and $result.running)
    } else {
    $hasAdminStatus=$null -ne $result.PSObject.Properties['has_admin'] -and $result.running
    if($hasAdminStatus){$script:adminReady=[bool]$result.has_admin}
    $admin.Enabled=[bool]($hasAdminStatus -and -not $script:adminReady)
    $open.Enabled=[bool]($result.running -and $script:adminReady)
    $mail.Enabled=[bool]($result.running)
    if($script:adminReady){$username.Clear();$email.Clear();$password.Clear();$confirmation.Clear()}
    if($action -eq 'create' -and $result.ok -and $result.admin_email_state -eq 'pending'){
      $script:bindingAccount=$script:createAccount
    }
    if($action -eq 'create'){$script:createAccount=''}
    if($script:securityResult -and $action -in @('status','mail')){& $script:securityResult $result $action}
    }
  } catch {
    $status.ForeColor=$script:theme.Text;$status.Text='后台未返回有效结果。请确认服务器包完整，或联系服务器维护人员。';$assistantResult.Text=$status.Text
    if($script:securityResult){& $script:securityResult @{ok=$false;message=$status.Text} $script:job.Action}
  } finally {
    $script:job.Process.Dispose();$script:job=$null;$start.Enabled=$refresh.Enabled=$assistantPanel.Enabled=$true
  }
})
$start.Add_Click({Begin-Operation 'start'})
$refresh.Add_Click({Begin-Operation 'status'})
$open.Add_Click({Begin-Operation 'open'})
function Show-LoginSecurity {
  $dialog=New-Object Windows.Forms.Form
  $dialog.Text='登录安全设置 · 本机服务器维护';$dialog.ClientSize=New-Object Drawing.Size(540,530)
  $dialog.StartPosition='CenterParent';$dialog.FormBorderStyle='FixedDialog';$dialog.MaximizeBox=$false
  $tabs=New-Object Windows.Forms.TabControl;$tabs.Dock='Fill';$dialog.Controls.Add($tabs)
  $binding=New-Object Windows.Forms.TabPage;$binding.Text='绑定内部账号邮箱';$tabs.Controls.Add($binding)
  $smtp=New-Object Windows.Forms.TabPage;$smtp.Text='验证码发信 SMTP';$tabs.Controls.Add($smtp)
  function Dialog-Field($Page,[string]$Text,[int]$Y,[bool]$Secret=$false) {
    if($Text){$label=New-Object Windows.Forms.Label;$label.Text=$Text;$label.Location=New-Object Drawing.Point(20,$Y);$label.Size=New-Object Drawing.Size(130,27);$Page.Controls.Add($label)}
    $box=New-Object Windows.Forms.TextBox;$box.Location=New-Object Drawing.Point(155,$Y);$box.Size=New-Object Drawing.Size(330,28);$box.MaxLength=4096;$box.UseSystemPasswordChar=$Secret;$Page.Controls.Add($box);return $box
  }
  $account=Dialog-Field $binding '已有织贸内部账号' 35
  $address=Dialog-Field $binding '绑定邮箱' 85
  $bindingCode=Dialog-Field $binding '8 位邮箱验证码' 190 $true
  $bindingCode.MaxLength=8
  $bindingCode.Enabled=$false
  if($script:bindingAccount){$account.Text=$script:bindingAccount}
  $notice=New-Object Windows.Forms.Label;$notice.Text='发送邮件后，请输入邮箱收到的 8 位验证码完成绑定。验证前保留现有绑定，不会创建业务登录会话。';$notice.Location=New-Object Drawing.Point(20,140);$notice.Size=New-Object Drawing.Size(470,45);$binding.Controls.Add($notice)
  $notice.Name='muted'
  $saveEmail=New-Object Windows.Forms.Button;$saveEmail.Text='发送绑定验证码';$saveEmail.Location=New-Object Drawing.Point(155,240);$saveEmail.Size=New-Object Drawing.Size(160,38);$binding.Controls.Add($saveEmail)
  $saveEmail.Name='primary-action'
  $resendBinding=New-Object Windows.Forms.Button;$resendBinding.Text='重发验证码';$resendBinding.Location=New-Object Drawing.Point(330,240);$resendBinding.Size=New-Object Drawing.Size(155,38);$binding.Controls.Add($resendBinding)
  $verifyBinding=New-Object Windows.Forms.Button;$verifyBinding.Text='验证并绑定';$verifyBinding.Location=New-Object Drawing.Point(155,290);$verifyBinding.Size=New-Object Drawing.Size(160,38);$binding.Controls.Add($verifyBinding)
  $bindingFeedback=New-Object Windows.Forms.Label;$bindingFeedback.Location=New-Object Drawing.Point(20,345);$bindingFeedback.Size=New-Object Drawing.Size(470,90);$binding.Controls.Add($bindingFeedback)
  $hostBox=Dialog-Field $smtp 'SMTP 主机' 25
  $portBox=Dialog-Field $smtp '端口' 72
  $security=New-Object Windows.Forms.ComboBox;$security.DropDownStyle='DropDownList';$null=$security.Items.AddRange(@('ssl','starttls'));$security.SelectedIndex=0;$security.Location=New-Object Drawing.Point(155,119);$security.Size=New-Object Drawing.Size(330,28);$smtp.Controls.Add($security)
  $securityLabel=New-Object Windows.Forms.Label;$securityLabel.Text='加密方式';$securityLabel.Location=New-Object Drawing.Point(20,119);$smtp.Controls.Add($securityLabel)
  $sender=Dialog-Field $smtp '发件邮箱' 166
  $smtpUser=Dialog-Field $smtp 'SMTP 账号' 213
  $smtpPassword=Dialog-Field $smtp 'SMTP 授权密码' 260 $true
  $smtpNotice=New-Object Windows.Forms.Label;$smtpNotice.Text='完整配置由服务器 DPAPI 加密保存，密码不回读。不自动发送测试邮件；不会从网站或样例猜测配置。';$smtpNotice.Location=New-Object Drawing.Point(20,310);$smtpNotice.Size=New-Object Drawing.Size(470,70);$smtp.Controls.Add($smtpNotice)
  $smtpNotice.Name='muted'
  $saveSmtp=New-Object Windows.Forms.Button;$saveSmtp.Text='保存发信配置';$saveSmtp.Location=New-Object Drawing.Point(155,400);$saveSmtp.Size=New-Object Drawing.Size(200,38);$smtp.Controls.Add($saveSmtp)
  $saveSmtp.Name='primary-action'
  $resetSmtp=New-Object Windows.Forms.Button;$resetSmtp.Text='重置';$resetSmtp.Location=$saveSmtp.Location;$resetSmtp.Size=$saveSmtp.Size;$smtp.Controls.Add($resetSmtp)
  $cancelSmtp=New-Object Windows.Forms.Button;$cancelSmtp.Text='取消重置';$cancelSmtp.Location=New-Object Drawing.Point(20,400);$cancelSmtp.Size=New-Object Drawing.Size(110,38);$smtp.Controls.Add($cancelSmtp)
  $securityPlaceholder=Dialog-Field $smtp '' 119
  $securityPlaceholder.Enabled=$false
  $securityPlaceholder.Text='已填写'
  $lockedPassword=Dialog-Field $smtp '' 260
  $lockedPassword.Enabled=$false
  $lockedPassword.Text='已填写'
  $smtp.AutoScroll=$true
  $guideToggle=New-Object Windows.Forms.Button
  $guideToggle.Text='如何获取 SMTP 配置';$guideToggle.Location=New-Object Drawing.Point(365,400);$guideToggle.Size=New-Object Drawing.Size(145,38)
  $smtp.Controls.Add($guideToggle)
  $smtpGuide=New-Object Windows.Forms.FlowLayoutPanel
  $smtpGuide.Location=New-Object Drawing.Point(20,454);$smtpGuide.Visible=$false
  $smtpGuide.FlowDirection='TopDown';$smtpGuide.WrapContents=$false;$smtpGuide.AutoSize=$true;$smtpGuide.AutoSizeMode='GrowAndShrink'
  $smtp.Controls.Add($smtpGuide)
  $guideText=New-Object Windows.Forms.Label
  $guideText.MaximumSize=New-Object Drawing.Size(465,0);$guideText.AutoSize=$true
  $guideText.Text=@'
阿里企业邮箱
1. 请邮箱管理员确认发件账号允许第三方客户端登录，并已开通 SMTP 服务。
2. 登录阿里邮箱网页版，进入「设置 → 查看更多设置 → 账户与安全 → 账户安全」。开启「三方客户端安全密码」，点击「生成新密码」并完成身份验证。密码只显示一次。若入口不可用，请联系邮箱管理员。
3. SMTP 主机填 smtp.qiye.aliyun.com，端口填 465，加密方式选 ssl。SMTP 账号填完整的企业邮箱地址，授权密码填生成的专用密码，发件邮箱填同一邮箱。使用其他发件地址前，请确认服务商已授权代发。
4. 保存后，用已绑定且由你掌控的内部账号在新窗口请求一次登录验证码。在收件箱或垃圾邮件中确认邮件及发件地址。

其他服务商请查找官方的发件服务器、端口、加密方式和授权码说明。仅在服务商支持时使用 587 + starttls。
'@
  $smtpGuide.Controls.Add($guideText)
  $guideLinks=@(
    @{Text='阿里邮箱服务器和端口';Url='https://help.aliyun.com/zh/document_detail/36576.html'},
    @{Text='生成客户端安全密码';Url='https://help.aliyun.com/zh/document_detail/444269.html'},
    @{Text='管理员配置访问策略';Url='https://help.aliyun.com/zh/document_detail/606337.html'}
  )
  foreach($item in $guideLinks){
    $link=New-Object Windows.Forms.LinkLabel
    $link.Text=$item.Text;$link.Tag=$item.Url;$link.AutoSize=$true
    $link.Add_LinkClicked({param($sender,$eventArgs) Start-Process -FilePath ([string]$sender.Tag) })
    $smtpGuide.Controls.Add($link)
  }
  $guideToggle.Add_Click({
    $smtpGuide.Visible=-not $smtpGuide.Visible
    $guideToggle.Text=if($smtpGuide.Visible){'收起配置说明'}else{'如何获取 SMTP 配置'}
    $smtp.PerformLayout()
    if($smtpGuide.Visible){$smtp.AutoScrollPosition=New-Object Drawing.Point(0,($guideToggle.Top-$smtp.AutoScrollPosition.Y-12))}
  })
  $state=@{Known=$false;Configured=$false;Sender='';Replacing=$false;Intent='';PendingAccount=$script:bindingAccount;CodeSent=$false}
  function Update-SecurityControls {
    $busy=[bool]$state.Intent
    $locked=$state.Configured -and -not $state.Replacing
    $editable=$state.Known -and -not $locked -and -not $busy
    foreach($field in @($hostBox,$portBox,$smtpUser,$sender)){$field.Enabled=$editable}
    $security.Visible=$smtpPassword.Visible=-not $locked
    $security.Enabled=$smtpPassword.Enabled=$editable
    $securityPlaceholder.Visible=$lockedPassword.Visible=$locked
    if($locked){
      $hostBox.Text=$portBox.Text=$smtpUser.Text='已填写'
      $sender.Text=if($state.Sender){$state.Sender}else{'无法读取'}
      $smtpPassword.Clear()
    }
    $saveSmtp.Visible=-not $locked
    $saveSmtp.Enabled=$editable
    $resetSmtp.Visible=$locked
    $resetSmtp.Enabled=$state.Known -and -not $busy
    $cancelSmtp.Visible=$state.Replacing
    $cancelSmtp.Enabled=-not $busy
    $account.Enabled=$address.Enabled=$saveEmail.Enabled=-not $busy
    $resendBinding.Enabled=-not $busy
    $bindingCode.Enabled=$verifyBinding.Enabled=-not $busy -and $state.CodeSent -and $account.Text -ceq $state.PendingAccount
  }
  function Invoke-SecurityAction([string]$Intent,[string]$Payload='') {
    if($state.Intent){return}
    $state.Intent=$Intent
    Update-SecurityControls
    if($Intent -eq 'status'){Begin-Operation 'status'}else{Begin-Operation 'mail' $Payload}
  }
  $script:securityResult={
    param($result,$action)
    $intent=$state.Intent
    $state.Intent=''
    if($null -ne $result.PSObject.Properties['smtp_configured']){
      $state.Known=$true
      $state.Configured=[bool]$result.smtp_configured
      $state.Sender=[string]$result.smtp_from_email
    }
    if($intent -like 'smtp*' -or $intent -eq 'status'){
      if($result.ok -and $intent -like 'smtp*'){$state.Replacing=$false}
      if($intent -eq 'status' -and $result.ok){
        $smtpNotice.Text=if($state.Configured -and -not $state.Sender){
          '已保存配置无法读取，请重置。'
        }else{'配置由服务器 DPAPI 加密保存。修改已保存配置请使用「重置」。'}
      }else{$smtpNotice.Text=[string]$result.message}
    }else{
      if($result.ok -and $intent -in @('bind-email-start','bind-email-resend')){
        $state.PendingAccount=$account.Text
        $state.CodeSent=[bool]$result.binding_confirmation_required
      }
      if($result.ok -and $intent -eq 'bind-email-verify'){
        $state.PendingAccount='';$script:bindingAccount='';$state.CodeSent=$false;$address.Clear()
      }
      $bindingFeedback.Text=[string]$result.message
    }
    Update-SecurityControls
  }
  $account.Add_TextChanged({Update-SecurityControls})
  $resetSmtp.Add_Click({
    $state.Replacing=$true
    $hostBox.Clear();$portBox.Clear();$smtpUser.Clear();$sender.Clear();$smtpPassword.Clear();$security.SelectedIndex=0
    $smtpNotice.Text='请输入新的完整配置。原配置将在新配置保存成功前继续生效。'
    Update-SecurityControls
  })
  $cancelSmtp.Add_Click({
    $state.Replacing=$false
    $smtpNotice.Text=if($state.Sender){'已保留原发信配置。'}else{'已保存配置无法读取，请重置。'}
    Update-SecurityControls
  })
  $saveEmail.Add_Click({
    if(-not $account.Text -or -not $address.Text){[Windows.Forms.MessageBox]::Show($dialog,'请填写已有内部账号及绑定邮箱。') | Out-Null;return}
    $bindingCode.Clear()
    $payload=@{operation='bind-email-start';username=$account.Text;email=$address.Text} | ConvertTo-Json -Compress
    Invoke-SecurityAction 'bind-email-start' $payload
  })
  $resendBinding.Add_Click({
    if(-not $account.Text){[Windows.Forms.MessageBox]::Show($dialog,'请填写已有内部账号。') | Out-Null;return}
    $bindingCode.Clear()
    $payload=@{operation='bind-email-resend';username=$account.Text} | ConvertTo-Json -Compress
    Invoke-SecurityAction 'bind-email-resend' $payload
  })
  $verifyBinding.Add_Click({
    if($bindingCode.Text -cnotmatch '^[0-9]{8}$'){[Windows.Forms.MessageBox]::Show($dialog,'请输入 8 位邮箱验证码。') | Out-Null;return}
    $payload=@{operation='bind-email-verify';username=$account.Text;code=$bindingCode.Text} | ConvertTo-Json -Compress
    $bindingCode.Clear()
    Invoke-SecurityAction 'bind-email-verify' $payload
  })
  $saveSmtp.Add_Click({
    $smtpPort=0
    if(-not [int]::TryParse($portBox.Text,[ref]$smtpPort) -or -not $hostBox.Text -or -not $sender.Text -or -not $smtpUser.Text -or -not $smtpPassword.Text){[Windows.Forms.MessageBox]::Show($dialog,'请填写完整 SMTP 配置和有效端口。') | Out-Null;return}
    $operation=if($state.Replacing){'smtp-replace'}else{'smtp'}
    $payload=@{operation=$operation;smtp=@{host=$hostBox.Text;port=$smtpPort;security=[string]$security.SelectedItem;from_email=$sender.Text;username=$smtpUser.Text;password=$smtpPassword.Text}} | ConvertTo-Json -Compress
    $hostBox.Clear();$portBox.Clear();$smtpUser.Clear();$sender.Clear();$smtpPassword.Clear()
    Invoke-SecurityAction $operation $payload
  })
  $dialog.Add_FormClosing({param($sender,$eventArgs) if($state.Intent){$eventArgs.Cancel=$true}})
  if($Probe){$state.Known=$true}else{$dialog.Add_Shown({Invoke-SecurityAction 'status'})}
  Update-SecurityControls
  Set-ServerTheme $dialog
  try{
    if($Probe){
      $tabs.SelectedIndex=1
      $state.Intent='smtp'
      & $script:securityResult ([pscustomobject]@{ok=$true;smtp_configured=$true;smtp_from_email='sender@example.invalid';message='已保存'}) 'mail'
      if($hostBox.Enabled -or $portBox.Enabled -or $smtpUser.Enabled -or $sender.Enabled -or $security.Enabled -or $smtpPassword.Enabled -or $saveSmtp.Enabled -or $hostBox.Text -ne '已填写' -or $sender.Text -ne 'sender@example.invalid'){
        throw 'SMTP saved state must lock all fields and display only the sender.'
      }
      Save-VisualProbe $dialog 'smtp-locked'
      $state.Replacing=$true
      $hostBox.Clear();$portBox.Clear();$smtpUser.Clear();$sender.Clear()
      $state.Intent='smtp-replace'
      & $script:securityResult ([pscustomobject]@{ok=$false;smtp_configured=$true;smtp_from_email='sender@example.invalid';message='保存失败'}) 'mail'
      if(-not $saveSmtp.Enabled -or $hostBox.Text -or $sender.Text -or $smtpPassword.Text){
        throw 'Failed SMTP replacement must preserve empty editing fields.'
      }
      $state.Replacing=$false
      Update-SecurityControls
      if($hostBox.Enabled -or $sender.Text -ne 'sender@example.invalid'){
        throw 'Cancelling SMTP replacement must restore the locked sender display.'
      }
      $state.Configured=$false
      $hostBox.Clear();$portBox.Clear();$smtpUser.Clear();$sender.Clear()
      Update-SecurityControls
    }
    if($Probe -and $VisualProbeDirectory){
      $tabs.SelectedIndex=0
      Save-VisualProbe $dialog 'email'
      $tabs.SelectedIndex=1;$dialog.PerformLayout();Save-VisualProbe $dialog 'smtp'
      $dialog.Show();[Windows.Forms.Application]::DoEvents()
      $guideToggle.PerformClick();[Windows.Forms.Application]::DoEvents()
      if(-not $smtpGuide.Visible -or $guideToggle.Text -ne '收起配置说明'){throw 'SMTP guide did not expand.'}
      Save-VisualProbe $dialog 'smtp-guide'
      $guideToggle.PerformClick()
      if($smtpGuide.Visible){throw 'SMTP guide did not collapse.'}
      if(-not $smtpPassword.UseSystemPasswordChar -or $account.Text -or $address.Text -or $smtpPassword.Text){throw 'Visual probe fields must stay empty and masked.'}
    }elseif(-not $Probe){$null=$dialog.ShowDialog($form)}
  }finally{$script:securityResult=$null;$bindingCode.Clear();$smtpPassword.Clear();$dialog.Dispose()}
}
$mail.Add_Click({Show-LoginSecurity})
$create.Add_Click({
  if($password.Text -cne $confirmation.Text){[Windows.Forms.MessageBox]::Show($form,'两次密码不一致。','请检查') | Out-Null;return}
  if([string]::IsNullOrWhiteSpace($username.Text) -or -not $email.Text -or -not $password.Text){[Windows.Forms.MessageBox]::Show($form,'请填写账号、绑定邮箱和密码。') | Out-Null;return}
  $payload=@{username=$username.Text;email=$email.Text;password=$password.Text} | ConvertTo-Json -Compress
  $script:createAccount=$username.Text
  $password.Clear();$confirmation.Clear()
  Begin-Operation 'create' $payload
  $payload=$null
})
if(-not ($VisibilityProbe -or $Probe)){$form.Add_Shown({Begin-Operation 'status'})}
Set-ServerTheme $form
Set-ServerTheme $managementDialog
$status.BackColor=$script:theme.Panel
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
    foreach($case in @(@('检查服务状态','status'),@('启动服务','start'),@('停止服务','stop'),@('重启服务器','restart'),@('运行 powershell',''))) {
      if((Resolve-ManagementIntent $case[0]) -ne $case[1]){throw '管理助手意图自检失败。'}
    }
    Request-ManagementAction 'stop' {return $false}
    if($null -ne $script:job -or $assistantResult.Text -notlike '已取消*'){throw '取消操作不应派发。'}
    function Begin-Operation([string]$Action,[string]$Payload='') {$script:probeAction=$Action;$script:probePayload=$Payload}
    Request-ManagementAction 'restart' {return $true}
    if($script:probeAction -ne 'manage-restart' -or $script:probePayload -ne '{"confirmed":true}'){throw '确认重启派发自检失败。'}
    $script:probeAction=''
    Request-ManagementAction 'shell' {throw '不应请求确认'}
    if($script:probeAction){throw '未支持意图不应派发。'}
    if($form.BackColor -ne $script:theme.Background -or $start.Name -ne 'primary-action' -or $start.Font.Name -ne $script:bodyFont.Name){throw 'Visual theme self-check failed.'}
    if($script:theme.Mode -eq 'HighContrast'){
      if($start.FlatStyle -ne 'Standard' -or $form.ForeColor -ne [Drawing.SystemColors]::ControlText){throw 'High-contrast native colors must be preserved.'}
    }elseif($start.BackColor -ne $script:theme.Accent -or $admin.BackColor -ne $script:theme.Panel -or $username.BackColor -ne $script:theme.Input){throw 'Shared action, panel and input tokens must be applied.'}
    if(-not $VisualProbeDirectory){Show-LoginSecurity}
    if($VisualProbeDirectory){
      $directory.Text='数据目录：合成预览';$status.Text='服务尚未启动。点击“启动服务”准备本机服务。'
      Save-VisualProbe $form 'server-disabled'
      $admin.Enabled=$true
      Save-VisualProbe $form 'server'
      $assistantResult.Text='只管理本安装的服务状态与启停。停止和重启需要再次确认。'
      Save-VisualProbe $managementDialog 'management'
      $form.Show();$mail.Enabled=$true;$mail.PerformClick()
    }
    exit 0
  } finally { $timer.Dispose(); $managementDialog.Dispose(); $form.Dispose() }
}
if($VisibilityProbe) {
  # Test only this process's own windows; the harness runs on a private desktop.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TradeLoomOwnWindowProbe {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
  $script:visibilityExit=4
  $visibilityTimer=New-Object Windows.Forms.Timer;$visibilityTimer.Interval=500
  $visibilityTimer.Add_Tick({
    $visibilityTimer.Stop()
    $visible=[TradeLoomOwnWindowProbe]::IsWindowVisible($form.Handle)
    $consoleVisible=[TradeLoomOwnWindowProbe]::IsWindowVisible([TradeLoomOwnWindowProbe]::GetConsoleWindow())
    $script:visibilityExit=if(-not $visible){2}elseif($consoleVisible){3}else{0}
    $form.Close()
  })
  $visibilityTimer.Start()
  try{$null=$form.ShowDialog()}finally{$visibilityTimer.Dispose();$timer.Dispose();$managementDialog.Dispose();$form.Dispose()}
  exit $script:visibilityExit
}
try { $null=$form.ShowDialog() } finally { $timer.Dispose();$managementDialog.Dispose();$form.Dispose() }
