# TradeLoom 企业客户端

这是独立 Electron 客户端，只连接单独运行的 TradeLoom Django 企业服务器。它不调用原工作台启动器，不启动本机 PostgreSQL、Django 或 DSH，也不要求安装 Python。

## Windows 启动

1. 如需从源码运行，在此目录执行 `npm install`，Electron 版本固定为 45.4.1。
2. 使用仓库中的 `scripts/package-enterprise-client.ps1` 生成 Windows 文件夹包，将 `dist/TradeLoom 企业服务器客户端` 整个目录交付，双击其中的 `TradeLoom 企业服务器客户端.exe` 即可。
3. 在同一登录页填写域名或公网 IP（可带端口）、织贸内部账号和密码。账号、密码初始为空。裸域名、IPv4 和方括号 IPv6 默认使用 HTTPS；显式 HTTPS 也可使用。登录成功后只将 origin 写入本机 `enterprise-client.json`，不保存账号或密码。
4. 密码通过后在同一页输入管理员绑定邮箱收到的 6 位验证码，再点击“验证并登录”。密码验证阶段不会创建认证会话。验证码 5 分钟有效、只能使用一次；可重新发送，但每 60 秒最多一次、每小时最多 5 次，连续输错 5 次需重新登录。登录由 main 通过同源 Django `/accounts/login/` 的 CSRF 与 Session 完成，不向远程页面注入密码，不新增登录 API。必须收到本次登录成功的同源 `/enterprise/` 重定向并验证会话后才接管窗口。错密、证书错误和连接失败保留原连接配置。
5. 需配套支持邮箱验证码的新版服务端（旧 rc15 密码登录服务不兼容）；升级前已存会话会要求重新两步验证。已完成邮箱验证的服务端会话有效时启动直接续用；失效则返回同一三字段登录页。菜单「个人端 → 连接台账服务」可更换连接或重新登录。

公网服务器必须使用 HTTPS，证书校验保持启用；只允许显式 `http://127.0.0.1` 或 `http://[::1]` 用于受控本机开发调试。不接受 URL 内嵌账号、路径、查询参数、片段或跨源登录跳转。

本地设置窗口拥有最小 preload API。远程企业页面不设置 preload，启用 `sandbox` 和 `contextIsolation`，禁用 `nodeIntegration`；只允许同源请求、跳转，不允许打开外部窗口。网页登录使用独立、按服务器 origin 隔离的持久 Electron session，不与 DSH/桌面工作台登录共享。

## 服务端首次配置与旧账号迁移

服务器本机 GUI 的“登录安全设置”可为已有内部账号补绑邮箱、配置 SMTP；首次管理员创建需填写绑定邮箱。已完成邮箱验证的超级管理员也可进入“企业控制台 → 登录安全”。普通老板/工厂账号不能指定收件人或修改发信配置。SMTP 使用服务器现有 DPAPI 密钥存储，配置仅显示状态、密码不回读；缺邮箱或缺 SMTP 时由本机 GUI/CLI 完成维护，不提供免认证的业务登录入口。

## 源码检查

```powershell
node --test apps/tradeloom-enterprise-client/tests/*.test.cjs
```

合成登录 smoke 使用 Electron 45.4.1 运行 `tests/electron-smoke.cjs`，传入 `--smoke-enterprise`、`--server-origin`、`--credentials-file` 、`--result-file` 和 `--code-stdin`，将合成收件箱验证码通过 stdin 送入；账号凭据只从隔离文件读取，不作为命令参数或输出。
