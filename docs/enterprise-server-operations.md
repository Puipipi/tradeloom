# 服务端运维入口

当前配置与角色操作见[企业控制台快速入门](enterprise-console-quickstart.md)。运维 API 位于 `/api/enterprise/operations/`，采用 Django 会话及同源 CSRF；固定诊断不授予任意命令执行权。

老板可管理固定凭据槽及明确确认的公告/单资源缓存操作；技术员只读诊断，工厂身份拒绝运维。凭据仅保存在服务端当前 Windows 账户 DPAPI vault，状态不证明秘密有效，无原文读取 API。ACL 校验失败时拒绝服务，不自动修改实际目录权限。

模型、Cloudflare、Windows OpenSSH 各自受固定动作和明确授权边界限制，应用身份不授予操作系统或远端登录权限。新增外部服务必须单独接入并验证，不通过助手扩展任意 URL 或 Shell。
