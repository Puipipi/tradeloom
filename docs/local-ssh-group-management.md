# 本机 SSH 专用组成员管理

此可选工具仅供服务器本机有效提升权限的 Windows 管理员使用。应用老板或技术员身份不授予 OS 权限；网页和个人端不提供远程成员写接口。

IT 须预先配置专用小写组 `tradeloom-ssh-users`，且默认全局 AllowGroups 中该组作为字面项恰好出现一次。工具不创建用户或组、不改 sshd_config、服务、密钥、密码或防火墙，不发起 SSH 连接。Match、Include、通配、其它用户拒绝/允许规则、自定义命令及不完整解析均拒写；不要为适配工具删除现有规则。

在完整 Server 包的64位 Windows PowerShell 5.1 中运行：

```powershell
.\Manage-SshAccess.ps1 -Action Check
.\Manage-SshAccess.ps1 -Action List
Get-LocalUser -Name '已有本机用户名' | Select-Object SID, Enabled
.\Manage-SshAccess.ps1 -Action Grant -UserSid '<已核对的普通本机用户SID>' -WhatIf
.\Manage-SshAccess.ps1 -Action Grant -UserSid '<已核对的普通本机用户SID>'
.\Manage-SshAccess.ps1 -Action Revoke -UserSid '<已核对的普通本机用户SID>'
```

Check 不枚举用户或成员；返回的 `ConfigState` 与 `ConfigReasons` 仅是读取状态和固定解析原因代码，不包含配置声明值。`partial_policy_manual_review` 表示存在无法安全判定的策略，不会推断某个用户能否登录。List 和变更要求 OS 管理员。目标须为同机现有普通本机用户，Grant 要求启用；域账号、高权限身份及复杂成员关系拒绝。变更有明确确认，WhatIf 不写；确认前后核对策略与成员快照，遇并发变化失败，不自动回滚别人的操作。

组成员资格不证明有效 SSH 登录，磁盘规则也不证明服务已加载。Revoke 不终止已建立会话。工具返回 `LoginVerified=false`；真实 Grant/Revoke 和登录需由 OS 管理员另行安排验收。
