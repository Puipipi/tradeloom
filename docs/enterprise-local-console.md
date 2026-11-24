# 可选本机控制台

默认仍使用 Django 账号登录。此入口只适用于安装服务的同一 Windows 账户及本机直接 HTTP；不提供不同 Windows 账号的集成登录，也不绕过远程 HTTPS 登录。

服务器已正常运行后，由安装账户在 Server 目录执行：

```powershell
.\scripts\Enable-LocalServerConsole.ps1 -DataRoot <原服务数据目录>
.\scripts\Open-ServerConsole.ps1 -DataRoot <原服务数据目录>
```

仅在该包确实包含以上 scripts 时使用；勿从其它版本拼入脚本。Enable 创建专用受限技术身份和 DPAPI 材料；Open 签发短期一次性授权并打开同源页面。票据只经 URL fragment 传递，页面清除后用同源 CSRF 请求兑换；不要复制或记录带票据的链接。`-PrintUrlOnly` 只输出无秘密地址，不签发票据。

该技术身份无密码、staff、superuser 或业务组，仅可运维诊断；不能写凭据、管理账号或准备/发布公告。会话硬到期15分钟，每次请求重新检查专属身份和本机直连条件；过期、重放、转发或 DPAPI 失败均拒绝。账号权限或密码改变后停止新签发。

自定义 DataRoot 必须在启动、Enable、Open 中保持一致。已有服务需正常重启以接收 DataRoot 环境；脚本不会启动服务。删除私有 `secrets\local-console.dpapi` 停止新签发；现有会话通过停用账号或正常退出撤销。私有材料不得随包分发。
