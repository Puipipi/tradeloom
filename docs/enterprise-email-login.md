# 邮箱验证码登录与服务器维护

个人端及正常 Web/Admin 登录统一经过 `/accounts/login/`：先验证内部账号密码，再向该账号由管理员绑定的 `User.email` 发 6 位验证码。密码阶段不授予认证 Session；验证码验证成功才登录。客户端不能指定收件人。旧版密码会话在新版服务上要求重新两步验证；个人端需要配套新版服务端。

验证码 5 分钟有效、一次使用、最多 5 次错误；同一账号发信间隔至少 60 秒，每小时最多 5 封。新码使旧码失效。验证码只以服务密钥 HMAC 摘要存库，密码和验证码不写入日志或明文配置。邮箱、密码、启停变化使待验证的码失效。发信失败不覆盖原挑战。

## 首次安装与旧管理员补绑

服务器 GUI 首次创建管理员须填写绑定邮箱。已安装账号可以通过同一个 GUI 的“登录安全设置”补绑邮箱与配置 SMTP，不要求先登录 Web，不创建业务会话，也不修改密码、用户组、角色、启停或历史数据。正常 Web 中已经完成两步验证的超级管理员可在“企业控制台 → 登录安全”维护。既有已启用的本机受限运维 grant 仍只服务管理入口，禁止用于业务页或个人端 capabilities；没有启用 grant 的安装也能使用 GUI helper 完成首次配置。

安装和升级需要运行非破坏性迁移 `enterprise_portal.0004_emailloginchallenge`。应用源码更新必须使用对应发行版的受支持升级流程；单纯替换发布目录不等于更新现有 DataRoot/app。

## 自动化本机维护接口

使用安装服务器的受信本机运行身份，执行 `scripts/ServerGuiBackend.ps1 -Action mail -DataRoot <本安装目录>`，通过 stdin 传入一行 JSON。服务与数据库须已启动并通过已有路径、进程、所属身份、端口与 DataRoot 归属校验。不要把秘密放入 argv、URL、Shell 历史或日志。

绑定邮箱的 payload 字段是 `operation: "bind-email"`、`username`、`email`。只接受具有密码的已有织贸内部账号，不更改本机运维专用身份。

SMTP payload 是 `operation: "smtp"`，以及 `smtp` 对象中的 `host`、整数 `port`、`security`、`username`、`password`、`from_email`。`security` 仅接受 `ssl` 或 `starttls`，要求正常证书验证；`from_email` 必须由管理人员明确指定有效邮箱，不根据账号或网站资料猜测。不会自动发送测试邮件。

完整 SMTP 配置存于既有 CurrentUser DPAPI 密钥库的固定 `smtp_configuration` 槽，写后会在同一身份解密、解析、核对，失败恢复旧密文。`status` 与 `mail` 的结果只含 `smtp_configured` 布尔及普通安装状态，不回传 host、账号、密码或发件邮箱。服务发码时动态读取配置，无需保存或依赖外部网站数据库。

## 验证

客户端：`node --test apps/tradeloom-enterprise-client/tests/*.test.cjs`。Django：使用明确的隔离 PostgreSQL 测试库和项目既有 `--keepdb` 防误删约束运行 `enterprise_portal.tests_email_login`；角色回归 fixture 使用 `enterprise_portal.testing.EmailVerifiedClient` 明确表示已验邮箱会话，认证测试仍使用原生 Client。真实集成应使用隔离 SMTP 收件服务、合成邮箱和独立 Electron profile，不发真实陌生收件人。
