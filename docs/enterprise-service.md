# 企业服务（Django）

## 入口和边界

企业服务是显式启用的 Django 部署模式，固定客户端入口为 `/enterprise/`。未登录时重定向到同源 `/accounts/login/`，使用 Django 用户、密码哈希、session cookie 和 CSRF。`/admin/` 仅供获准的 staff 管理员维护账号、启用/禁用用户并分配组；老板业务权限由“企业老板”组授权。没有预置生产账号或密码。

企业模式使用 PostgreSQL 和独立 URLConf。它只挂载明确授权的企业入口、登录、管理与健康检查，不会将旧的无团队权限 `/products`、`/orders` 或 `/api/*` 业务入口开放给员工。老板及相应显式读授权可从同源只读业务页读取企业数据库的Task/Product固定字段、Customer名录和严格校验的CustomerEvent来源报价数值；工厂/运维身份拒绝优先，完整ERP与商品价目仍未接入；登记员的服务端查询只返回本人创建或共享给其工厂组的登记记录。每条登记可关联现有业务批次；工厂组由管理员创建，名称以 `工厂:` 开头。没有业务批次或产品时页面显示自然空状态。

## Windows 独立企业服务器包

本节适用于团队交付的完整 `TradeLoomEnterpriseServer-Windows-x64.zip`。先将整个压缩包解压到 Windows 服务器上的新文件夹，再用运行服务器的 Windows 账号打开 PowerShell，切换到解压后的文件夹。

首次安装运行：

```powershell
.\Install-EnterpriseServer.ps1
```

完整服务器包自带 Python、Django 和 PostgreSQL 运行环境，安装器会自动找到它们，不需要选择文件夹。仅在从源码目录运行且没有随包运行环境时，安装器才会询问位置。此时选择已验证 TradeLoom 程序的 `app\resources` 文件夹，或用 `-RuntimeSource` 指定运行环境目录。

安装器会创建独立数据库和随机服务密钥，将服务器文件、数据库及账号数据放在当前 Windows 账号的 `%LOCALAPPDATA%\TradeLoomEnterpriseServer` 下，并启动仅供本机访问的服务。过程中会提示创建首个 Django 超级管理员用户名和密码。密码不会由安装器保存，请妥善保管。该账号用于服务器管理，不要把它作为日常企业业务账号分发。

服务启动后，本机 Electron 客户端使用 `http://127.0.0.1:27417` 连接服务器。在客户端的“服务器地址”栏输入该地址并选择“连接”，然后在打开的登录页使用管理员账号。如需使用服务器上的 HTTPS 反向代理，客户端地址应使用该站点的安全来源，例如 `https://trade.example.com`。此处只填写协议、主机名和可选端口，不要附加 `/enterprise/` 路径。服务器包不会创建或修改网站、DNS、代理或隧道。没有已部署且获准使用的 HTTPS 入口时，只能在服务器本机使用 loopback 地址，不要将本地 HTTP 或数据库端口开放给其他设备。

### 启用受信任 HTTPS 反向代理

新的服务器安装默认仍为本机 HTTP。只有已配置受信任的 HTTPS 反向代理时，才在首次安装时传入公共 HTTPS 地址：

```powershell
.\Install-EnterpriseServer.ps1 -ExternalHttpsUrl "https://trade.example.com/enterprise/"
```

该选项会启用 Django HTTPS 代理模式，按 URL 的来源设置允许的 Host 与 CSRF 来源、`X-Forwarded-Proto: https` 代理识别、HTTP 跳转以及 Secure session/CSRF cookies。URL 必须是绝对 HTTPS 地址，不含用户名、密码、查询或片段；路径只允许空路径、`/` 或 `/enterprise/`。安装器只保存来源并启动 loopback HTTP 上游，不创建 TLS 证书、反向代理、隧道或 DNS。反向代理应终止经过验证的 TLS，保留该公共 Host、覆盖传入的 `X-Forwarded-Proto` 为 `https`，并只转发到 `127.0.0.1:27417`。不要将上游或 PostgreSQL 端口暴露到外部网络。

已安装且停止的旧服务器可以显式切换，无需重装。旧版配置即使保存过 `external_https_url`，未显式启用前仍保持原 HTTP 行为：

```powershell
.\Start-EnterpriseServer.ps1 -EnableHttps -ExternalHttpsUrl "https://trade.example.com/enterprise/"
```

如果旧配置已有该 URL，也可只传 `-EnableHttps`。切换之前先运行随包 `Stop-EnterpriseServer.ps1`。之后普通启动会沿用已保存模式。要回到本机 HTTP，先停止服务，再运行 `Start-EnterpriseServer.ps1 -DisableHttps`；客户端地址应改为 `http://127.0.0.1:27417`。HTTPS 模式启动检查会分别确认受信代理头下 PostgreSQL 健康，并确认不带该头的上游请求会被重定向到已配置的 HTTPS 来源。

## 创建企业账号和设置权限

管理员登录后打开同一服务器的 `/admin/`，进入用户和用户组管理。安装时已准备好两个业务用户组。用户组入口是 `/admin/auth/group/`，用户入口是 `/admin/auth/user/`。先创建所需的工厂组，再新增用户并在用户编辑页分配相应用户组。

- 日常企业负责人账号分配到 `企业老板` 组。该角色可查看业务批次、产品资料和全部登记记录，并可新增登记。
- 工厂登记员账号分配到 `工厂登记员` 组。每家工厂还需有一个名称以 `工厂:` 开头的用户组，例如 `工厂:苏州`，并将对应登记员加入该组。

普通企业负责人和登记员不要设置为 staff 或超级管理员。分配完成后，负责人和登记员在 Electron 客户端的“服务器地址”栏输入相同服务器地址并选择“连接”，再用各自的用户名与密码登录。登记员只会看到本人登记或共享给其所属工厂组的记录。需要撤销账号访问时，在 `/admin/` 打开对应用户并取消“有效”状态。账号、组和数据都保存在服务器 Windows 账号的数据目录，不与 Electron 客户端或原 TradeLoom 工作台的账号设置共用。

## 启停与数据位置

完成安装后，在解压服务器包的文件夹运行以下命令：

```powershell
.\Start-EnterpriseServer.ps1
.\Stop-EnterpriseServer.ps1
```

安装时服务已自动启动。再次运行启动命令会检查并复用本安装的服务。停止命令只停止这套安装对应的 Django 和 PostgreSQL 进程。以后启停都应使用安装时相同的 Windows 账号，因为默认数据位置属于该账号。不要把服务器数据目录放进程序包、桌面 profile 或 Electron 客户端目录。安装器不会覆盖非空数据目录，迁移或移除前请先单独备份并审查数据。

已有 PostgreSQL 用户仍可使用外接数据库模式：设置独立的 `TRADELOOM_ENTERPRISE_SECRET_KEY`、`TRADELOOM_DB_NAME`、`TRADELOOM_DB_USER`、`TRADELOOM_DB_PASSWORD`、`TRADELOOM_DB_HOST`、`TRADELOOM_DB_PORT` 后，在项目根运行：

```powershell
.\scripts\start-enterprise.ps1 -CreateAdmin -Python .\.venv\Scripts\python.exe -Port 27417
```

外接非 loopback PostgreSQL 必须显式设置 `TRADELOOM_ENTERPRISE_DATABASE_ALLOW_REMOTE=1` 及 TLS `TRADELOOM_ENTERPRISE_DATABASE_SSLMODE=verify-full`（或经审查的模式）。本机模式默认禁用外接数据库。管理员可在 `/admin/` 新建用户、设密码、分配“企业老板”/“工厂登记员”或按 `工厂:` 前缀创建派工范围组、停用账号。

## 远端 HTTPS 部署

为 Django 配置独立 PostgreSQL 数据库、从秘密管理器注入随机 `TRADELOOM_ENTERPRISE_SECRET_KEY` 和 DB 密码、显式主机与 HTTPS 来源。配置示例（域名、数据库和秘密来源替换为已授权的私有部署值）：

```sh
export DJANGO_SETTINGS_MODULE=config.enterprise_settings
export TRADELOOM_ENTERPRISE_SECRET_KEY="$(secret-tool-read tradeloom/django-secret-key)"
export TRADELOOM_ENTERPRISE_ALLOWED_HOSTS=workbench.example.org
export TRADELOOM_ENTERPRISE_CSRF_TRUSTED_ORIGINS=https://workbench.example.org
export TRADELOOM_ENTERPRISE_BIND_HOST=127.0.0.1
export TRADELOOM_ENTERPRISE_HTTPS=1
export TRADELOOM_DB_NAME=tradeloom
export TRADELOOM_DB_USER=tradeloom_service
export TRADELOOM_DB_PASSWORD="$(secret-tool-read tradeloom/postgres-password)"
export TRADELOOM_DB_HOST=postgres.private.example.org
export TRADELOOM_DB_PORT=5432
export TRADELOOM_ENTERPRISE_DATABASE_ALLOW_REMOTE=1
export TRADELOOM_ENTERPRISE_DATABASE_SSLMODE=verify-full
python manage.py migrate --noinput
python manage.py configure_enterprise_groups
python manage.py createsuperuser
python -m pip install gunicorn
python manage.py collectstatic --noinput
gunicorn config.wsgi:application --bind 127.0.0.1:8000
```

`secret-tool-read` 是部署方秘密管理器的示意命令，不能把实际密钥替换进版本库或命令记录。若 PostgreSQL 不在 loopback，必须启用 TLS；推荐 `verify-full`，其它 SSL mode 需要单独审查。Django 进程固定绑定 loopback，由 HTTPS 反向代理转发，并设置正确的代理 HTTPS 头。远端部署还需配置静态资源收集与备份恢复。本仓库 PowerShell 脚本使用 Django `runserver`，只适用于 loopback 开发验证，不是生产 WSGI 管理器。

可由已获授权的 HTTPS 反向代理提供外部入口；该部署步骤需单独审核源站隔离、TLS 和访问策略。本安装器不修改 Cloudflare、隧道、DNS 或现有网站目录。

## 控制台与分发

账号、角色、个人端版本和操作入口见[企业控制台快速入门](enterprise-console-quickstart.md)。服务器包与个人端包分别分发；仅服务器包携带数据库运行环境。
